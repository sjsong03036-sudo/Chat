from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import os
import shutil
import base64
import json
import fitz  # PyMuPDF
from dotenv import load_dotenv
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_chroma import Chroma
from langchain_core.documents import Document

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DOCS_DIR = "./docs"
CHROMA_DIR = "./chroma_db"
os.makedirs(DOCS_DIR, exist_ok=True)

embedding = OpenAIEmbeddings(model="text-embedding-3-small")
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
db = Chroma(persist_directory=CHROMA_DIR, embedding_function=embedding)


class ChatRequest(BaseModel):
    message: str


@app.post("/rag/chat")
async def rag_chat(req: ChatRequest):
    retriever = db.as_retriever(search_kwargs={"k": 3})
    docs = retriever.invoke(req.message)

    if not docs:
        return {"reply": "관련 문서를 찾을 수 없습니다. 먼저 문서를 업로드해주세요.", "sources": []}

    context = "\n\n".join([d.page_content for d in docs])
    sources = list(set([d.metadata.get("source", "알 수 없음") for d in docs]))

    prompt = f"""너는 내부 문서를 기반으로 답변하는 도우미다.
반드시 아래 [문맥]에 있는 내용만 근거로 답변해라.
문맥에 없는 내용은 "해당 정보를 찾을 수 없습니다"라고 답해라.

[문맥]
{context}

[질문]
{req.message}

[답변]"""

    response = await llm.ainvoke(prompt)
    return {"reply": response.content, "sources": sources}


def extract_image_descriptions(file_path: str) -> list[Document]:
    pdf = fitz.open(file_path)
    image_docs = []

    for page_num in range(len(pdf)):
        page = pdf[page_num]
        for img in page.get_images(full=True):
            xref = img[0]
            base_image = pdf.extract_image(xref)
            image_bytes = base_image["image"]

            # 5KB 미만 이미지는 아이콘/장식으로 간주하고 스킵
            if len(image_bytes) < 5000:
                continue

            ext = base_image["ext"]
            b64 = base64.b64encode(image_bytes).decode("utf-8")

            try:
                response = llm.invoke([{
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/{ext};base64,{b64}"}
                        },
                        {
                            "type": "text",
                            "text": "이 이미지를 상세히 설명해라. 표, 차트, 그래프, 수치가 있으면 내용을 최대한 추출해서 설명해라."
                        }
                    ]
                }])
                image_docs.append(Document(
                    page_content=f"[이미지 설명 - {page_num + 1}페이지] {response.content}",
                    metadata={"source": file_path, "page": page_num + 1, "type": "image"}
                ))
            except Exception as e:
                print(f"이미지 설명 실패 (page {page_num + 1}): {e}")

    return image_docs


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
SUPPORTED_EXTS = {".pdf", ".txt"} | IMAGE_EXTS

def describe_single_image(file_path: str) -> list[Document]:
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    if ext == "jpg":
        ext = "jpeg"

    with open(file_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")

    try:
        response = llm.invoke([{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/{ext};base64,{b64}"}
                },
                {
                    "type": "text",
                    "text": "이 이미지를 상세히 설명해라. 표, 차트, 그래프, 수치가 있으면 내용을 최대한 추출해서 설명해라."
                }
            ]
        }])
        return [Document(
            page_content=f"[이미지 설명] {response.content}",
            metadata={"source": file_path, "type": "image"}
        )]
    except Exception as e:
        print(f"이미지 설명 실패: {e}")
        return []


@app.post("/rag/upload")
async def upload_document(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()

    if ext not in SUPPORTED_EXTS:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 파일 형식입니다: {ext}")

    file_path = os.path.join(DOCS_DIR, file.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    chunks = []
    image_docs = []

    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
        documents = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = splitter.split_documents(documents)
        image_docs = extract_image_descriptions(file_path)

    elif ext == ".txt":
        loader = TextLoader(file_path, encoding="utf-8")
        documents = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = splitter.split_documents(documents)

    elif ext in IMAGE_EXTS:
        image_docs = describe_single_image(file_path)

    all_docs = chunks + image_docs
    if all_docs:
        db.add_documents(all_docs)

    return {
        "success": True,
        "chunks": len(chunks),
        "image_descriptions": len(image_docs),
        "filename": file.filename
    }


@app.get("/rag/status")
async def status():
    total_chunks = db._collection.count()
    total_documents = len(os.listdir(DOCS_DIR))
    return {"total_chunks": total_chunks, "total_documents": total_documents}


@app.get("/rag/documents")
async def list_documents():
    files = sorted(os.listdir(DOCS_DIR))
    return {"documents": files}


@app.delete("/rag/documents/{filename}")
async def delete_document(filename: str):
    file_path = os.path.join(DOCS_DIR, filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    db._collection.delete(where={"source": file_path})
    os.remove(file_path)

    return {"success": True, "filename": filename}

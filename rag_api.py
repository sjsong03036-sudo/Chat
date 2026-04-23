from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import shutil
from dotenv import load_dotenv
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_community.vectorstores import Chroma

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

    prompt = f"""너는 내부 문서를 기반으로 답변하는 도우미다.
반드시 아래 [문맥]에 있는 내용만 근거로 답변해라.
문맥에 없는 내용은 "해당 정보를 찾을 수 없습니다"라고 답해라.
답변 마지막에 참고한 문서 출처를 간략히 언급해라.

[문맥]
{context}

[질문]
{req.message}

[답변]"""

    response = llm.invoke(prompt)
    sources = list(set([d.metadata.get("source", "알 수 없음") for d in docs]))

    return {"reply": response.content, "sources": sources}


@app.post("/rag/upload")
async def upload_document(file: UploadFile = File(...)):
    file_path = os.path.join(DOCS_DIR, file.filename)

    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    if file.filename.endswith(".pdf"):
        loader = PyPDFLoader(file_path)
    else:
        loader = TextLoader(file_path, encoding="utf-8")

    documents = loader.load()
    splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
    chunks = splitter.split_documents(documents)

    db.add_documents(chunks)

    return {"success": True, "chunks": len(chunks), "filename": file.filename}


@app.get("/rag/status")
async def status():
    count = db._collection.count()
    return {"total_chunks": count}

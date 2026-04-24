# ─── 외부 라이브러리 임포트 ──────────────────────────────────────────────────
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware  # 브라우저의 CORS 요청 허용
from fastapi.responses import StreamingResponse     # SSE 스트리밍 응답
from pydantic import BaseModel                      # 요청 바디 스키마 정의
import os
import shutil      # 파일 복사 (업로드 저장)
import base64      # 이미지를 base64로 인코딩해 LLM에 전달
import json
import asyncio     # 동기 블로킹 함수를 스레드풀에서 실행해 이벤트 루프 차단 방지
import fitz        # PyMuPDF: PDF에서 이미지 추출
from dotenv import load_dotenv

# LangChain 관련: 문서 로딩, 텍스트 분할, 임베딩, 벡터 DB, LLM
from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_chroma import Chroma
from langchain_core.documents import Document

load_dotenv() # .env 파일의 OPENAI_API_KEY를 환경변수로 로드

# ─── FastAPI 앱 초기화 ────────────────────────────────────────────────────────
app = FastAPI()

# Node.js 서버(port 3000)에서 오는 요청만 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 경로 및 모델 초기화 ──────────────────────────────────────────────────────
DOCS_DIR = "./docs"       # 업로드된 원본 파일 저장 폴더
CHROMA_DIR = "./chroma_db" # ChromaDB 벡터 데이터 저장 폴더
os.makedirs(DOCS_DIR, exist_ok=True)

embedding = OpenAIEmbeddings(model="text-embedding-3-small") # 텍스트를 벡터로 변환하는 임베딩 모델
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)         # 답변 생성 LLM (temperature=0: 일관된 응답)
db = Chroma(persist_directory=CHROMA_DIR, embedding_function=embedding) # 로컬 벡터 데이터베이스


# ─── 요청 스키마 ──────────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str # 사용자 질문 텍스트


# ─── RAG 채팅 엔드포인트 ──────────────────────────────────────────────────────
# 1) 질문과 유사한 문서 청크를 ChromaDB에서 검색
# 2) 검색된 내용을 문맥으로 LLM에게 전달해 답변 생성
# 3) 답변과 출처 파일 목록을 JSON으로 반환
@app.post("/rag/chat")
async def rag_chat(req: ChatRequest):
    retriever = db.as_retriever(search_kwargs={"k": 3}) # 유사도 상위 3개 청크 검색
    docs = retriever.invoke(req.message)

    if not docs:
        return {"reply": "관련 문서를 찾을 수 없습니다. 먼저 문서를 업로드해주세요.", "sources": []}

    # 검색된 청크 내용을 하나의 문자열로 합쳐 문맥(context) 구성
    context = "\n\n".join([d.page_content for d in docs])
    # 출처 파일 경로 목록 (중복 제거)
    sources = list(set([d.metadata.get("source", "알 수 없음") for d in docs]))

    # 문맥 기반 답변만 허용하는 프롬프트 구성
    prompt = f"""너는 내부 문서를 기반으로 답변하는 도우미다.
반드시 아래 [문맥]에 있는 내용만 근거로 답변해라.
문맥에 없는 내용은 "해당 정보를 찾을 수 없습니다"라고 답해라.

[문맥]
{context}

[질문]
{req.message}

[답변]"""

    response = await llm.ainvoke(prompt) # 비동기 LLM 호출
    return {"reply": response.content, "sources": sources}


# ─── PDF 이미지 설명 추출 ─────────────────────────────────────────────────────
# PDF 각 페이지의 이미지를 추출해 GPT Vision으로 설명을 생성하고 Document로 반환
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
            b64 = base64.b64encode(image_bytes).decode("utf-8") # 이미지를 base64로 인코딩

            try:
                # GPT Vision에 이미지와 설명 요청 프롬프트 전달
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
                # 생성된 설명을 Document 객체로 래핑해 ChromaDB에 저장 가능한 형태로 변환
                image_docs.append(Document(
                    page_content=f"[이미지 설명 - {page_num + 1}페이지] {response.content}",
                    metadata={"source": file_path, "page": page_num + 1, "type": "image"}
                ))
            except Exception as e:
                print(f"이미지 설명 실패 (page {page_num + 1}): {e}")

    return image_docs


# ─── 지원 파일 형식 정의 ──────────────────────────────────────────────────────
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
SUPPORTED_EXTS = {".pdf", ".txt"} | IMAGE_EXTS

# 단독 이미지 파일을 GPT Vision으로 설명하고 Document로 반환
def describe_single_image(file_path: str) -> list[Document]:
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    if ext == "jpg":
        ext = "jpeg" # MIME 타입 통일

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


# ─── 문서 업로드 엔드포인트 (SSE 스트리밍) ───────────────────────────────────
# 처리 단계마다 진행 이벤트를 SSE로 전송:
#   saved    → 파일 저장 완료
#   chunking → 텍스트 분할 시작
#   chunked  → 분할 완료 (청크 수 포함)
#   imaging  → 이미지 분석 시작
#   imaged   → 이미지 분석 완료 (이미지 수 포함)
#   embedding→ 임베딩 배치 진행 (done/total 포함)
#   done     → 모든 처리 완료 (최종 통계)
#   error    → 오류 발생 (메시지 포함)
@app.post("/rag/upload")
async def upload_document(file: UploadFile = File(...)):
    async def generate():
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in SUPPORTED_EXTS:
            yield f"data: {json.dumps({'error': f'지원하지 않는 파일 형식입니다: {ext}'})}\n\n"
            return

        # 파일을 docs 폴더에 저장
        file_path = os.path.join(DOCS_DIR, file.filename)
        content = await file.read()
        with open(file_path, "wb") as f:
            f.write(content)
        yield f"data: {json.dumps({'stage': 'saved'})}\n\n"

        chunks = []
        image_docs = []

        if ext == ".pdf":
            yield f"data: {json.dumps({'stage': 'chunking'})}\n\n"
            loader = PyPDFLoader(file_path)
            documents = loader.load()
            splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
            chunks = splitter.split_documents(documents)
            yield f"data: {json.dumps({'stage': 'chunked', 'count': len(chunks)})}\n\n"

            yield f"data: {json.dumps({'stage': 'imaging'})}\n\n"
            # 동기 블로킹 함수를 스레드풀에서 실행해 SSE 전송이 끊기지 않도록 처리
            image_docs = await asyncio.to_thread(extract_image_descriptions, file_path)
            yield f"data: {json.dumps({'stage': 'imaged', 'count': len(image_docs)})}\n\n"

        elif ext == ".txt":
            yield f"data: {json.dumps({'stage': 'chunking'})}\n\n"
            loader = TextLoader(file_path, encoding="utf-8")
            documents = loader.load()
            splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
            chunks = splitter.split_documents(documents)
            yield f"data: {json.dumps({'stage': 'chunked', 'count': len(chunks)})}\n\n"

        elif ext in IMAGE_EXTS:
            yield f"data: {json.dumps({'stage': 'imaging'})}\n\n"
            image_docs = await asyncio.to_thread(describe_single_image, file_path)
            yield f"data: {json.dumps({'stage': 'imaged', 'count': len(image_docs)})}\n\n"

        all_docs = chunks + image_docs
        total_docs = len(all_docs)

        if all_docs:
            # 5개씩 배치로 임베딩해 진행률을 실시간으로 전송
            BATCH = 5
            for i in range(0, total_docs, BATCH):
                batch = all_docs[i:i + BATCH]
                await asyncio.to_thread(db.add_documents, batch)
                done = min(i + BATCH, total_docs)
                yield f"data: {json.dumps({'stage': 'embedding', 'done': done, 'total': total_docs})}\n\n"

        yield f"data: {json.dumps({'stage': 'done', 'chunks': len(chunks), 'images': len(image_docs), 'filename': file.filename})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ─── RAG 상태 조회 엔드포인트 ────────────────────────────────────────────────
# ChromaDB의 총 청크 수와 docs 폴더의 파일 수를 반환
@app.get("/rag/status")
async def status():
    total_chunks = db._collection.count()
    total_documents = len(os.listdir(DOCS_DIR))
    return {"total_chunks": total_chunks, "total_documents": total_documents}


# ─── 문서 목록 조회 엔드포인트 ───────────────────────────────────────────────
# docs 폴더에 저장된 파일명을 정렬해 반환
@app.get("/rag/documents")
async def list_documents():
    files = sorted(os.listdir(DOCS_DIR))
    return {"documents": files}


# ─── 문서 삭제 엔드포인트 ────────────────────────────────────────────────────
# 1) docs 폴더에서 원본 파일 삭제
# 2) ChromaDB에서 해당 파일 경로를 source 메타데이터로 가진 청크 전체 삭제
@app.delete("/rag/documents/{filename}")
async def delete_document(filename: str):
    file_path = os.path.join(DOCS_DIR, filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    db._collection.delete(where={"source": file_path}) # ChromaDB 청크 삭제
    os.remove(file_path)                               # 원본 파일 삭제

    return {"success": True, "filename": filename}

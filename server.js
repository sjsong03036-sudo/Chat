// ─── 외부 모듈 불러오기 ───────────────────────────────────────────────────────
import express from 'express';   // 웹 서버 프레임워크
import OpenAI from 'openai';     // OpenAI API 클라이언트
import dotenv from 'dotenv';     // .env 파일에서 환경변수 로드
import multer from 'multer';     // 파일 업로드 처리 미들웨어

dotenv.config(); // .env 파일의 OPENAI_API_KEY 등을 process.env에 등록

// ─── 앱 초기화 ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());          // 요청 본문을 JSON으로 파싱
app.use(express.static('public')); // public 폴더의 HTML/CSS/JS를 정적 파일로 제공

// ─── 클라이언트 및 설정 ────────────────────────────────────────────────────────
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // OpenAI 인증
const upload = multer({ storage: multer.memoryStorage() }); // 파일을 디스크 대신 메모리에 임시 저장
const RAG_URL = 'http://localhost:8000'; // FastAPI RAG 서버 주소

// ─── 일반 채팅 API ────────────────────────────────────────────────────────────
// 사용자 메시지를 받아 GPT-4o-mini에게 전달하고 응답을 반환
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    try {
        const response = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: message }],
        });
        res.json({ reply: response.choices[0].message.content });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── RAG 서버 공통 fetch 헬퍼 ─────────────────────────────────────────────────
// FastAPI 서버에 요청을 보내고 응답을 안전하게 JSON으로 파싱
// FastAPI가 JSON 대신 오류 텍스트를 반환할 때도 처리 가능
async function ragFetch(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    try {
        return { ok: response.ok, data: JSON.parse(text) };
    } catch {
        return { ok: false, data: { error: text || 'RAG 서버 오류' } };
    }
}

// ─── RAG 채팅 API ─────────────────────────────────────────────────────────────
// 사용자 메시지를 FastAPI RAG 서버로 중계하고 문서 기반 응답을 반환
app.post('/api/rag/chat', async (req, res) => {
    try {
        const { ok, data } = await ragFetch(`${RAG_URL}/rag/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

// ─── 문서 업로드 API (SSE 프록시) ────────────────────────────────────────────
// multer로 파일을 메모리에 받은 뒤 FastAPI로 전달하고,
// FastAPI가 보내는 SSE 진행 이벤트를 그대로 브라우저로 스트리밍
app.post('/api/rag/upload', upload.single('file'), async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
        const formData = new FormData();
        formData.append('file', blob, req.file.originalname);

        const upstream = await fetch(`${RAG_URL}/rag/upload`, {
            method: 'POST',
            body: formData,
        });

        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
    } catch (err) {
        console.error(err);
        res.write(`data: ${JSON.stringify({ error: 'RAG 서버에 연결할 수 없습니다.' })}\n\n`);
    }
    res.end();
});

// ─── RAG 상태 조회 API ────────────────────────────────────────────────────────
// 업로드된 문서 수와 총 청크 수를 반환
app.get('/api/rag/status', async (_req, res) => {
    try {
        const { ok, data } = await ragFetch(`${RAG_URL}/rag/status`);
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

// ─── 문서 목록 조회 API ───────────────────────────────────────────────────────
// docs 폴더에 저장된 파일명 목록을 반환
app.get('/api/rag/documents', async (_req, res) => {
    try {
        const { ok, data } = await ragFetch(`${RAG_URL}/rag/documents`);
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

// ─── 문서 삭제 API ────────────────────────────────────────────────────────────
// 파일명을 받아 docs 폴더에서 삭제하고 ChromaDB에서도 해당 청크 제거
app.delete('/api/rag/documents/:filename', async (req, res) => {
    try {
        const { ok, data } = await ragFetch(
            `${RAG_URL}/rag/documents/${encodeURIComponent(req.params.filename)}`,
            { method: 'DELETE' }
        );
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

// ─── 서버 시작 ────────────────────────────────────────────────────────────────
app.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
});

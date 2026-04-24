import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });
const RAG_URL = 'http://localhost:8000';

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

async function ragFetch(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    try {
        return { ok: response.ok, data: JSON.parse(text) };
    } catch {
        return { ok: false, data: { error: text || 'RAG 서버 오류' } };
    }
}

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

app.post('/api/rag/upload', upload.single('file'), async (req, res) => {
    try {
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
        const formData = new FormData();
        formData.append('file', blob, req.file.originalname);

        const { ok, data } = await ragFetch(`${RAG_URL}/rag/upload`, {
            method: 'POST',
            body: formData,
        });
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

app.get('/api/rag/status', async (_req, res) => {
    try {
        const { ok, data } = await ragFetch(`${RAG_URL}/rag/status`);
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

app.get('/api/rag/documents', async (_req, res) => {
    try {
        const { ok, data } = await ragFetch(`${RAG_URL}/rag/documents`);
        res.status(ok ? 200 : 500).json(data);
    } catch (err) {
        res.status(500).json({ error: 'RAG 서버에 연결할 수 없습니다.' });
    }
});

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

app.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
});

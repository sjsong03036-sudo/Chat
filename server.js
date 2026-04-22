import express from 'express';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));  // public 폴더를 정적 파일로 서빙

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 브라우저에서 POST /api/chat 으로 요청이 오면 Gemini 호출
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: message,
    });

    res.json({ reply: response.text });
});

app.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
});

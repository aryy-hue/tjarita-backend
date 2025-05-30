// server.js
require('dotenv').config(); // Untuk memuat .env di lokal
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const dbPool = require('./db'); // Koneksi database kita

const app = express();
const PORT = process.env.PORT || 3000;

// Variabel dari .env atau disuntikkan oleh GCP
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!NEWS_API_KEY || !GEMINI_API_KEY || !JWT_SECRET) {
    console.error("FATAL ERROR: NEWS_API_KEY, GEMINI_API_KEY, atau JWT_SECRET tidak terdefinisi.");
    if (process.env.NODE_ENV === 'production') process.exit(1); // Keluar jika di produksi
    else console.warn("Pastikan variabel lingkungan di atas ada di file .env untuk development lokal.");
}


// Middleware
app.use(express.json()); // Untuk parsing body JSON

// --- Fungsi Pembantu & Middleware ---

// Middleware untuk Autentikasi Token JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer TOKEN

    if (token == null) {
        return res.status(401).json({ error: 'Akses ditolak. Token tidak tersedia.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message);
            return res.status(403).json({ error: 'Token tidak valid atau kedaluwarsa.' });
        }
        req.user = user; // Menyimpan payload token (misal: { userId, username }) ke object request
        next();
    });
}

// Fungsi untuk Meringkas Teks dengan Gemini API
async function summarizeWithGemini(text) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY tidak dikonfigurasi.');
    try {
        const modelName = 'gemini-1.5-flash-latest'; // Atau 'gemini-1.5-pro-latest'
        const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
        const requestBody = {
            contents: [{ parts: [{ text: `Buat ringkasan singkat sekitar 1-2 kalimat dalam bahasa Indonesia dari teks berita berikut:\n\n"${text}"` }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 200, topP: 0.9, topK: 40 }
        };
        const response = await axios.post(API_ENDPOINT, requestBody, { headers: { 'Content-Type': 'application/json' }, timeout: 25000 });

        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            return response.data.candidates[0].content.parts[0].text.trim();
        } else {
            console.error('Gemini API response format unexpected or no text:', response.data?.candidates?.[0]?.content);
            if (response.data?.candidates?.[0]?.finishReason === 'SAFETY') throw new Error('Ringkasan diblokir karena alasan keamanan oleh Gemini API.');
            throw new Error('Tidak ada konten teks yang dihasilkan atau format respons tidak sesuai dari Gemini API.');
        }
    } catch (error) {
        let errorMessage = 'Gagal meringkas dengan Gemini API.';
        if (error.response) {
            console.error('Gemini API Error Response:', error.response.data?.error || error.response.statusText);
            errorMessage = error.response.data?.error?.message || error.response.statusText || 'Error dari Gemini API';
            if (error.response.status === 429) errorMessage = "Kuota Gemini API telah tercapai.";
        } else if (error.code === 'ECONNABORTED') {
            errorMessage = 'Koneksi ke Gemini API timeout';
        } else {
            errorMessage = error.message || errorMessage;
        }
        throw new Error(`Gagal meringkas: ${errorMessage}`);
    }
}


// --- Rute Autentikasi ---
app.post('/auth/register', async (req, res) => {
    const { username, email, password, country } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, dan password diperlukan.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter.' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const query = 'INSERT INTO users (username, email, password_hash, country) VALUES (?, ?, ?, ?)';
        const [result] = await dbPool.execute(query, [username, email, passwordHash, country || null]);
        res.status(201).json({ message: 'Registrasi berhasil!', userId: result.insertId });
    } catch (error) {
        console.error('Error Registrasi:', error);
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username atau email sudah digunakan.' });
        res.status(500).json({ error: 'Kesalahan server saat registrasi.' });
    }
});

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email dan password diperlukan.' });

    try {
        const query = 'SELECT * FROM users WHERE email = ?';
        const [rows] = await dbPool.execute(query, [email]);
        if (rows.length === 0) return res.status(401).json({ error: 'Email atau password salah.' });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Email atau password salah.' });

        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ message: 'Login berhasil!', token, user: { id: user.id, username: user.username, email: user.email, country: user.country } });
    } catch (error) {
        console.error('Error Login:', error);
        res.status(500).json({ error: 'Kesalahan server saat login.' });
    }
});

// --- Rute API Berita (Dilindungi) ---
app.get('/api/articles', authenticateToken, async (req, res) => {
    if (!NEWS_API_KEY) return res.status(500).json({error: "NEWS_API_KEY tidak dikonfigurasi di server."});
    try {
        const newsResponse = await axios.get('https://newsapi.org/v2/top-headlines', {
            params: {
                country: req.query.country || req.user.country || 'us', // Gunakan negara user jika ada, atau query, atau default 'us'
                category: req.query.category || 'business',
                apiKey: NEWS_API_KEY,
                pageSize: 10
            },
            timeout: 10000
        });

        const articlesToDisplay = newsResponse.data.articles.map(article => ({
            id: article.url,
            title: article.title,
            source: article.source?.name || 'Unknown',
            url: article.url,
            image: article.urlToImage || null,
            description: article.description,
            content: article.content, // NewsAPI content seringkali snippet
            publishedAt: article.publishedAt
        }));

        res.json({
            message: `Artikel untuk user: ${req.user.username}`,
            totalResults: newsResponse.data.totalResults,
            articles: articlesToDisplay
        });
    } catch (error) {
        console.error('News API Error:', error.response?.data || error.message);
        let errorMessage = 'Gagal mengambil artikel.';
        if (error.response?.status === 401 || error.response?.status === 429) errorMessage = error.response.data.message || "Error dari NewsAPI (unauthorized/quota)";
        res.status(500).json({ error: errorMessage });
    }
});

// Rute untuk Meringkas Teks Artikel (On-demand, Dilindungi)
app.post('/api/summarize', authenticateToken, async (req, res) => {
    const { textToSummarize } = req.body;
    if (!textToSummarize || textToSummarize.trim() === "") {
        return res.status(400).json({ error: 'Teks untuk diringkas tidak boleh kosong.' });
    }
    try {
        const truncatedText = textToSummarize.slice(0, 20000); // Batasi panjang input
        const summary = await summarizeWithGemini(truncatedText);
        res.json({ summary });
    } catch (error) {
        console.error('Error Summarize On-Demand:', error.message);
        res.status(500).json({ error: error.message || 'Gagal membuat ringkasan on-demand.' });
    }
});


// Rute default /
app.get('/', (req, res) => {
    res.send(`Selamat datang di News App API! Server berjalan di port ${PORT}. Environment: ${process.env.NODE_ENV || 'not set'}`);
});


// Jalankan server
app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'production') {
        console.log('Berjalan dalam mode produksi.');
    } else {
        console.log('Berjalan dalam mode development.');
    }
});
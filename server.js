require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Mengganti DEEPSEEK_API_KEY

// Validasi environment variables
if (!NEWS_API_KEY || !GEMINI_API_KEY) { // Memeriksa GEMINI_API_KEY
  console.error('ERROR: API keys not found in environment variables!');
  process.exit(1);
}

// Endpoint untuk mendapatkan artikel
app.get('/api/articles', async (req, res) => {
  try {
    // 1. Dapatkan artikel dari News API
    const newsResponse = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        country: req.query.country || 'us',
        category: req.query.category || 'business',
        apiKey: NEWS_API_KEY,
        pageSize: 10
      },
      timeout: 10000 // Timeout untuk News API
    });

    // 2. Filter artikel yang memiliki konten minimal
    const validArticles = newsResponse.data.articles.filter(article =>
      article.title && (article.content || article.description)
    );

    if (validArticles.length === 0) {
      return res.status(404).json({
        error: 'Tidak ada artikel dengan konten yang cukup',
        totalResults: newsResponse.data.articles.length,
        suggestion: 'Coba kategori atau negara berbeda'
      });
    }

    // 3. Ambil hanya 5 artikel pertama untuk efisiensi
    const articlesToProcess = validArticles.slice(0, 5);

    // 4. Proses artikel
    const processedArticles = await Promise.all(
      articlesToProcess.map(async (article) => {
        try {
          // Gunakan title + description jika content tidak ada
          const textToSummarize = article.content
            ? `${article.title}. ${article.content}`
            : `${article.title}. ${article.description}`;

          // Potong teks jika terlalu panjang (Gemini memiliki batasan input token)
          // Batas input token Gemini Pro adalah sekitar 30720 token. 20000 karakter aman.
          const truncatedText = textToSummarize.slice(0, 20000);

          // Ringkas artikel menggunakan Gemini
          const summary = await summarizeWithGemini(truncatedText); // Mengganti summarizeWithDeepSeek

          return {
            id: article.url,
            title: article.title,
            source: article.source?.name || 'Unknown',
            url: article.url,
            image: article.urlToImage || null,
            summary: summary,
            publishedAt: article.publishedAt
          };
        } catch (error) {
          console.error(`Gagal memproses artikel: ${article.title}`, error.message);
          return {
            ...article, // Kembalikan artikel asli jika ringkasan gagal
            summary: "Gagal membuat ringkasan: " + error.message,
            image: article.urlToImage || null // Pastikan image tetap ada
          };
        }
      })
    );

    res.json({
      message: 'Berhasil mendapatkan artikel',
      totalResults: newsResponse.data.totalResults,
      articles: processedArticles
    });

  } catch (error) {
    console.error('News API Error:', error.response?.data || error.message);

    let errorMessage = 'Terjadi kesalahan server';
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.message || error.response.statusText;
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Koneksi ke News API timeout';
    } else if (error.message.includes('ENOTFOUND')) {
      errorMessage = 'Tidak dapat terhubung ke News API';
    }

    res.status(statusCode).json({
      error: errorMessage,
      api: 'News API'
    });
  }
});

// Fungsi untuk meringkas teks menggunakan Gemini API
async function summarizeWithGemini(text) {
    try {
      // GANTI NAMA MODEL DI SINI:
      // Coba 'gemini-1.5-flash-latest' (lebih cepat, hemat biaya)
      // atau 'gemini-1.5-pro-latest' (kualitas tertinggi)
      const modelName = 'gemini-1.5-flash-latest'; // Atau 'gemini-1.5-pro-latest'
      const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  
      const requestBody = {
        contents: [{
          parts: [{
            text: `Buat ringkasan singkat sekitar 1-2 kalimat dalam bahasa Indonesia dari teks berita berikut:\n\n"${text}"`
          }]
        }],
        generationConfig: {
          temperature: 0.6, // Sedikit kurangi untuk ringkasan yang lebih faktual
          maxOutputTokens: 200,
          topP: 0.9,
          topK: 40
        }
      };
  
      const response = await axios.post(API_ENDPOINT, requestBody, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 25000
      });
  
      if (response.data && response.data.candidates && response.data.candidates.length > 0 &&
          response.data.candidates[0].content && response.data.candidates[0].content.parts &&
          response.data.candidates[0].content.parts.length > 0 && response.data.candidates[0].content.parts[0].text) { // Tambah pengecekan .text
        return response.data.candidates[0].content.parts[0].text.trim();
      } else {
        // Jika respons tidak sesuai format yang diharapkan atau tidak ada teks
        console.error('Gemini API response format unexpected or no text:', response.data?.candidates?.[0]?.content);
        // Cek apakah ada 'finishReason' yang menunjukkan masalah lain
        if (response.data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Ringkasan diblokir karena alasan keamanan oleh Gemini API.');
        } else if (response.data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
            throw new Error('Ringkasan melebihi batas token output. Coba kurangi maxOutputTokens atau perpendek input.');
        } else if (!response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Tidak ada konten teks yang dihasilkan oleh Gemini API.');
        }
        throw new Error('Format respons tidak sesuai dari Gemini API');
      }
  
    } catch (error) {
      let errorMessage = 'Gagal meringkas dengan Gemini API.';
      if (error.response) {
        console.error('Gemini API Error Response:', error.response.data?.error || error.response.statusText);
        errorMessage = error.response.data?.error?.message || error.response.statusText || 'Error dari Gemini API';
        if (error.response.data?.error?.details) {
           console.error('Gemini API Error Details:', error.response.data.error.details);
        }
        if (error.response.status === 429) {
            errorMessage = "Kuota Gemini API telah tercapai. Coba lagi nanti.";
        } else if (error.response.status === 404) {
            errorMessage = `Model tidak ditemukan atau tidak didukung: ${modelName}. Coba periksa nama model.`;
        } else if (error.response.status === 400) {
            // Seringkali error 400 dari Gemini berarti ada masalah dengan request (misal, format prompt, safety settings)
            errorMessage = `Permintaan ke Gemini API tidak valid (Bad Request): ${error.response.data?.error?.message || 'Periksa format permintaan atau konten.'}`;
            if (response.data?.promptFeedback?.blockReason) { // Jika ada feedback karena diblokir
              errorMessage += ` Alasan pemblokiran: ${response.data.promptFeedback.blockReason}`;
            }
        }
      } else if (error.code === 'ECONNABORTED') {
        errorMessage = 'Koneksi ke Gemini API timeout';
      } else {
        console.error('Gemini API Request Error:', error.message);
        // Jika error dilempar dari dalam blok 'try' sebelum ada error.response
        if (error.message.startsWith('Ringkasan diblokir') || error.message.startsWith('Tidak ada konten teks')) {
            errorMessage = error.message;
        } else {
            errorMessage = error.message || 'Terjadi kesalahan pada permintaan Gemini API.';
        }
      }
      throw new Error(`Gagal meringkas: ${errorMessage}`);
    }
  }

// Jalankan server
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/api/articles`);
});
const express = require('express');
const Song = require('../models/Song');
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');
const upload = require('../middleware/multer.js'); // Import the instance directly
const cloudinary = require('../config/cloudinaryConfig');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

const router = express.Router();

// Retry helper for Gemini API calls
// Retries on 429 (rate limit) and 5xx errors, with exponential backoff
async function geminiWithRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode || (err.response && err.response.status);
      const retryable = status === 429 || status === 500 || status === 503 || !status;
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s
      console.warn(`Gemini attempt ${attempt} failed (status ${status}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// GET all songs with optional filtering by language and genre
router.get('/', async (req, res) => {
  try {
    // Extract query parameters
    const { language, genre } = req.query;
    
    // Build filter object
    const filter = {};
    
    // Add language filter if provided
    if (language) {
      filter.language = language;
    }
    
    // Add genre filter if provided
    if (genre) {
      filter.genre = genre;
    }
    
    // Fetch songs with the filter (empty filter returns all songs)
    const songs = await Song.find(filter).populate('uploadedBy', 'name email').sort({ createdAt: -1 });
    
    res.status(200).json({ 
      success: true, 
      count: songs.length, 
      songs: songs,
      filters: { language, genre } // Optional: include applied filters in response
    });
  } catch (error) {
    console.error('Get songs error:', error);
    res.status(500).json({ success: false, message: "Server error occurred while fetching songs." });
  }
});

// GET search songs by text
router.get('/search', async (req, res) => {
  try {
    // Get search term from query parameters
    const { q } = req.query;
    
    // If no search term provided, return empty array
    if (!q || q.trim() === '') {
      return res.status(200).json({
        success: true,
        count: 0,
        songs: []
      });
    }
    
    // Try text search first, fallback to regex search if text index doesn't exist
    let songs;
    try {
      // Perform text search using the text index
      songs = await Song.find({
        $text: { $search: q }
      })
      .limit(10)
      .populate('uploadedBy', 'name email')
      .sort({ score: { $meta: 'textScore' } }); // Sort by relevance score
    } catch (textSearchError) {
      console.log('Text search failed, using regex fallback:', textSearchError.message);
      // Fallback to regex search if text index doesn't exist
      songs = await Song.find({
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { artist: { $regex: q, $options: 'i' } },
          { genre: { $regex: q, $options: 'i' } },
          { language: { $regex: q, $options: 'i' } }
        ]
      })
      .limit(10)
      .populate('uploadedBy', 'name email')
      .sort({ createdAt: -1 });
    }
    
    res.status(200).json({
      success: true,
      count: songs.length,
      songs: songs,
      searchTerm: q
    });
  } catch (error) {
    console.error('Search songs error:', error);
    res.status(500).json({
      success: false,
      message: "Server error occurred while searching songs."
    });
  }
});

// Test route to check Cloudinary configuration
router.get('/test-config', (req, res) => {
  try {
    const config = cloudinary.config();
    res.json({
      success: true,
      message: 'Cloudinary configuration test',
      hasCloudName: !!config.cloud_name,
      hasApiKey: !!config.api_key,
      hasApiSecret: !!config.api_secret,
      cloudName: config.cloud_name // Safe to show cloud name
    });
  } catch (error) {
    console.error('Config test error:', error);
    res.status(500).json({
      success: false,
      message: 'Cloudinary configuration error',
      error: error.message
    });
  }
});

// GET featured songs
router.get('/featured', async (req, res) => {
  try {
    const featuredSongs = await Song.find({ featured: true })
      .limit(10)
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 });
      
    res.status(200).json({
      success: true,
      count: featuredSongs.length,
      songs: featuredSongs
    });
  } catch (error) {
    console.error('Get featured songs error:', error);
    res.status(500).json({
      success: false,
      message: "Server error occurred while fetching featured songs."
    });
  }
});

// GET generate queue with specified duration
router.get('/queue/generate', async (req, res) => {
  try {
    // Get duration from query parameters
    const { duration } = req.query;
    
    // Validate duration parameter
    if (!duration) {
      return res.status(400).json({
        success: false,
        message: "Duration parameter is required."
      });
    }
    
    const durationMinutes = parseFloat(duration);
    
    // Check if duration is a valid number
    if (isNaN(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({
        success: false,
        message: "Duration must be a valid positive number in minutes."
      });
    }
    
    // Convert duration from minutes to seconds
    const requestedDurationSeconds = durationMinutes * 60;
    
    // Use MongoDB aggregation pipeline to get a random sample of songs
    const sampledSongs = await Song.aggregate([
      { $sample: { size: 50 } }
    ]);
    
    // Build the queue by adding songs until we reach the requested duration
    const queue = [];
    let totalDuration = 0;
    
    for (const song of sampledSongs) {
      // Add song to queue
      queue.push(song);
      totalDuration += song.duration;
      
      // Stop if we've reached or exceeded the requested duration
      if (totalDuration >= requestedDurationSeconds) {
        break;
      }
    }
    
    res.status(200).json({
      success: true,
      requestedDurationMinutes: durationMinutes,
      requestedDurationSeconds: requestedDurationSeconds,
      actualDurationSeconds: totalDuration,
      actualDurationMinutes: Math.round((totalDuration / 60) * 100) / 100,
      count: queue.length,
      queue: queue
    });
    
  } catch (error) {
    console.error('Generate queue error:', error);
    res.status(500).json({
      success: false,
      message: "Server error occurred while generating queue."
    });
  }
});

// POST a new song with a thumbnail
router.post(
  '/upload',
  authMiddleware,
  // Use the imported multer instance and specify the fields for this route
  upload.fields([
    { name: 'song', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!req.files || !req.files.song || !req.files.thumbnail) {
        return res.status(400).json({ success: false, message: 'Both song and thumbnail files are required.' });
      }

      const songFile = req.files.song[0];
      const thumbnailFile = req.files.thumbnail[0];

      const uploadSongPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ resource_type: 'video', folder: 'sonore/songs' }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
        stream.end(songFile.buffer);
      });

      const uploadThumbnailPromise = new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: 'sonore/thumbnails' }, (error, result) => {
          if (error) return reject(error);
          resolve(result);
        });
        stream.end(thumbnailFile.buffer);
      });

      const [songResult, thumbnailResult] = await Promise.all([uploadSongPromise, uploadThumbnailPromise]);

      // Debug: Log received form data
      console.log('Upload route - received req.body:', req.body);
      console.log('Upload route - req.body.genre:', req.body.genre);
      console.log('Upload route - req.body.language:', req.body.language);

      const newSong = new Song({
        title: req.body.title,
        artist: req.body.artist,
        album: req.body.album || 'Unknown Album',
        duration: parseInt(req.body.duration),
        genre: req.body.genre || 'Unknown',
        language: req.body.language || 'Unknown',
        featured: req.body.featured === 'true' || req.body.featured === true,
        url: songResult.secure_url,
        thumbnail: thumbnailResult.secure_url,
        uploadedBy: req.user.id,
      });

      const savedSong = await newSong.save();
      res.status(201).json({ success: true, message: 'Song uploaded successfully!', song: savedSong });

    } catch (error) {
      console.error('Upload route error:', error);
      res.status(500).json({ success: false, message: 'Server error during file upload.' });
    }
  }
);

// GET video ID for a song using AI-generated search query (rewritten with improved prompt and self-correction)
router.get('/:id/video', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch song details
    const song = await Song.findById(id).select('title artist');
    if (!song) {
      return res.status(404).json({ success: false, message: 'Song not found' });
    }

    const title = (song.title || '').trim();
    const artist = (song.artist || '').trim();

    // 2. Build a detailed, multi-line prompt for Gemini
    const prompt = `You are an expert music video researcher. Your goal is to produce a single, concise YouTube search query that will most likely surface the official music video (or official audio/lyric video) for a given song.

Instructions:
- Prioritize the song title and the artist's official channel when possible.
- Include one or more common keywords such as "Official Music Video", "Official Video", "Official Audio", or "lyric video" to increase the chance of finding the correct official upload.
- Use the artist's name in the query.
- Keep the query short (one line), formatted exactly as a search query string, and return only that query text with no extra commentary or explanation.

Song title: "${title}"
Artist: "${artist}"

Return only the search query text.`;

    // 3. Call Gemini to generate a candidate query
    let aiQuery = '';
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ success: false, message: 'GEMINI_API_KEY not configured' });
      }
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await geminiWithRetry(() => model.generateContent(prompt));
      const response = await result.response;
      aiQuery = (response && response.text && response.text().trim()) || '';
      console.log('Gemini candidate query:', aiQuery);
    } catch (err) {
      console.error('Gemini generation error after retries:', err);
      aiQuery = '';
    }

    // 4. Self-correction: ensure the AI query contains the artist and at least one keyword
    const fallbackQuery = `${title} ${artist} official video`;
    const keywords = ['official', 'video', 'audio', 'lyric'];
    const containsArtist = artist ? aiQuery.toLowerCase().includes(artist.toLowerCase()) : false;
    const containsKeyword = keywords.some(k => aiQuery.toLowerCase().includes(k));

    let finalQuery = aiQuery;
    let usedFallback = false;
    if (!aiQuery || !containsArtist || !containsKeyword) {
      finalQuery = fallbackQuery;
      usedFallback = true;
      console.log('AI query discarded; using fallback query:', finalQuery);
    } else {
      console.log('Using AI-generated query as final query:', finalQuery);
    }

    // 5. Use the finalQuery with the YouTube Data API
    try {
      if (!process.env.YOUTUBE_API_KEY) {
        return res.status(500).json({ success: false, message: 'YOUTUBE_API_KEY not configured' });
      }
      const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: finalQuery,
        type: 'video',
        maxResults: 5,
        order: 'relevance'
      });

      const items = (searchResponse && searchResponse.data && searchResponse.data.items) || [];
      if (!items || items.length === 0) {
        return res.status(404).json({ success: false, message: 'No video found for this song' });
      }

      // Rank results: prefer title+artist match, then official keyword match, then rest
      const titleLower = title.toLowerCase();
      const artistLower = artist.toLowerCase();
      const officialKeywords = ['official', 'lyric', 'audio'];

      const scored = items
        .filter(item => item.id && item.id.videoId)
        .map(item => {
          const t = (item.snippet && item.snippet.title || '').toLowerCase();
          let score = 0;
          if (t.includes(titleLower) && t.includes(artistLower)) score += 3;
          else if (t.includes(titleLower)) score += 2;
          if (officialKeywords.some(k => t.includes(k))) score += 1;
          return { videoId: item.id.videoId, score };
        })
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        return res.status(404).json({ success: false, message: 'No video id found in YouTube response' });
      }

      // Return top 3 so the frontend can try fallbacks if one is embed-blocked
      const videoIds = scored.slice(0, 3).map(s => s.videoId);

      return res.status(200).json({
        success: true,
        videoId: videoIds[0],
        videoIds,
        searchQuery: finalQuery,
        aiCandidate: aiQuery,
        usedFallback
      });
    } catch (ytErr) {
      console.error('YouTube API error:', ytErr);
      return res.status(500).json({ success: false, message: 'Failed to search YouTube for video' });
    }

  } catch (error) {
    console.error('Unexpected error in video route:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred while fetching video' });
  }
});

// GET streamable lyrics for a song using Server-Sent Events (SSE)
router.get('/:id/lyrics/stream', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Ensure the connection stays open for SSE
    res.flushHeaders && res.flushHeaders();

    // Fetch song
    const song = await Song.findById(id);
    if (!song) {
      // send an SSE error event then close
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Song not found' })}\n\n`);
      } catch (e) {}
      return res.end();
    }

    // If lyrics already exist in DB, send them in a single data event and close
    if (song.lyrics && song.lyrics.trim() !== '') {
      try {
        res.write(`data: ${JSON.stringify({ lyrics: song.lyrics })}\n\n`);
      } catch (e) {
        console.error('Error writing existing lyrics SSE:', e);
      }
      return res.end();
    }

    // No lyrics: initialize Gemini streaming
    if (!process.env.GEMINI_API_KEY) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'GEMINI_API_KEY not configured' })}\n\n`);
      return res.end();
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Build a detailed prompt for lyrics generation
    const title = (song.title || '').trim();
    const artist = (song.artist || '').trim();
    const prompt = `You are a highly skilled songwriter and lyricist. Write full song lyrics for the following song. Keep the style consistent, include verses, a chorus, and bridge if appropriate, and make sure the lyrics are original and suitable for general audiences. Preserve the song title and artist references only for context, but do not include extra commentary. Return only the lyrics text (no explanations or headers).\n\nSong title: "${title}"\nArtist: "${artist}"\n\nLyrics:`;

    let accumulated = '';

    try {
      const result = await geminiWithRetry(() => model.generateContentStream(prompt));

      for await (const chunk of result.stream) {
        try {
          const text = chunk.text();
          if (!text) continue;
          res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
          accumulated += text;
        } catch (innerErr) {
          console.error('Error while streaming chunk to client:', innerErr);
        }
      }

      // After stream finishes, save accumulated lyrics to DB
      try {
        song.lyrics = accumulated;
        await song.save();
      } catch (saveErr) {
        console.error('Failed to save generated lyrics:', saveErr);
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Failed to save lyrics' })}\n\n`);
      }

      res.write(`event: done\ndata: ${JSON.stringify({ message: 'finished' })}\n\n`);
      return res.end();

    } catch (aiErr) {
      console.error('Error during Gemini streaming after retries:', aiErr);
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'AI streaming error: ' + aiErr.message })}\n\n`);
      return res.end();
    }

  } catch (error) {
    console.error('Unexpected error in lyrics stream route:', error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Unexpected server error' })}\n\n`);
    } catch (e) {}
    return res.end();
  }
});

// GET insight for a song using Gemini
router.get('/:id/insights', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch song details (title and artist)
    let song;
    try {
      song = await Song.findById(id).select('title artist insights');
    } catch (dbErr) {
      console.error('Database error while fetching song for insights:', dbErr);
      return res.status(500).json({ success: false, message: 'Database error while fetching song.' });
    }

    if (!song) {
      return res.status(404).json({ success: false, message: 'Song not found' });
    }

    // Return cached insight if available
    if (song.insights && song.insights.trim() !== '') {
      return res.status(200).json({ insight: song.insights });
    }

    const title = (song.title || '').trim();
    const artist = (song.artist || '').trim();

    // 2. Ensure API key is configured
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'GEMINI_API_KEY not configured' });
    }

  // 3. Build a detailed prompt: act as an engaging music historian and produce a single paragraph (100-150 words)
  const prompt = `You are an engaging, well-informed music historian. Compose a single, well-written paragraph (about 100-150 words) that serves as a "Song Insight" for the song below. The paragraph should succinctly cover several interesting points: the song's creation and production (who was involved, notable collaborators or production details if known), the story or meaning behind the lyrics, the song's cultural or social impact (how it resonated with listeners, influenced a scene, or reflected trends), and any notable awards, chart milestones, or recognitions. Use a warm, authoritative, and accessible tone. Do NOT include bullet points, lists, sources, or extra commentary — return only one continuous paragraph as the insight.

Song title: "${title}"
Artist: "${artist}"

Return only the single-paragraph insight (100-150 words).`;

    // 4. Call Gemini to generate the insight
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await geminiWithRetry(() => model.generateContent(prompt));
      const response = await result.response;
      const insightText = (response && response.text && response.text().trim()) || '';

      if (!insightText) {
        console.error('Gemini returned empty insight for song:', id);
        return res.status(500).json({ success: false, message: 'AI returned no insight for this song.' });
      }

      // Cache insight in DB so future requests skip Gemini
      try {
        song.insights = insightText;
        await song.save();
      } catch (saveErr) {
        console.error('Failed to cache insight in DB:', saveErr);
      }

      return res.status(200).json({ insight: insightText });
    } catch (aiErr) {
      console.error('Gemini generation error for insights after retries:', aiErr);
      return res.status(500).json({ success: false, message: 'Failed to generate insight from AI.' });
    }

  } catch (error) {
    console.error('Unexpected error in insights route:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred while fetching insight.' });
  }
});

module.exports = router;
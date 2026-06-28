require('dotenv').config();
const mongoose = require('mongoose');
const https = require('https');
const Song = require('../models/Song');

const DELAY_BETWEEN_REQUESTS = 300; // ms between iTunes API calls
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // ms before retrying after failure
const BATCH_SIZE = 20; // log progress every N songs

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetch from iTunes API with retry logic
async function fetchItunesThumbnail(title, artist, retryCount = 0) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(`${title} ${artist}`);
    const url = `https://itunes.apple.com/search?term=${query}&media=music&limit=5`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.results && parsed.results.length > 0) {
            // Try to find best match — prefer exact title match
            const exactMatch = parsed.results.find(
              (r) => r.trackName && r.trackName.toLowerCase() === title.toLowerCase()
            );
            const result = exactMatch || parsed.results[0];
            // Get high-res version: replace 100x100 with 500x500
            const thumbUrl = result.artworkUrl100
              ? result.artworkUrl100.replace('100x100bb', '500x500bb')
              : null;
            resolve({ success: true, url: thumbUrl, matchedTrack: result.trackName, matchedArtist: result.artistName });
          } else {
            resolve({ success: false, reason: 'no results' });
          }
        } catch (e) {
          resolve({ success: false, reason: `parse error: ${e.message}` });
        }
      });
    });

    req.on('error', async (err) => {
      if (retryCount < MAX_RETRIES) {
        console.log(`   ⚠️  Network error, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await sleep(RETRY_DELAY * (retryCount + 1));
        resolve(fetchItunesThumbnail(title, artist, retryCount + 1));
      } else {
        resolve({ success: false, reason: `network error after ${MAX_RETRIES} retries: ${err.message}` });
      }
    });

    req.setTimeout(10000, () => {
      req.destroy();
      if (retryCount < MAX_RETRIES) {
        console.log(`   ⚠️  Request timed out, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        sleep(RETRY_DELAY).then(() => resolve(fetchItunesThumbnail(title, artist, retryCount + 1)));
      } else {
        resolve({ success: false, reason: 'timeout after retries' });
      }
    });
  });
}

// Update song thumbnail in MongoDB with retry logic
async function updateSongThumbnail(songId, thumbnailUrl, retryCount = 0) {
  try {
    await Song.findByIdAndUpdate(songId, { thumbnail: thumbnailUrl });
    return true;
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await sleep(RETRY_DELAY);
      return updateSongThumbnail(songId, thumbnailUrl, retryCount + 1);
    }
    return false;
  }
}

async function fixThumbnails() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected.\n');

  const songs = await Song.find({}, '_id title artist thumbnail');
  const total = songs.length;
  console.log(`🎵 Found ${total} songs to process.\n`);
  console.log('─'.repeat(60));

  const stats = {
    updated: 0,
    skipped: 0,
    failed: 0,
    failedSongs: [],
  };

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const num = `[${i + 1}/${total}]`;

    if (i > 0 && i % BATCH_SIZE === 0) {
      console.log(`\n📊 Progress: ${i}/${total} processed — ✅ ${stats.updated} updated, ⚠️  ${stats.failed} failed, ⏭️  ${stats.skipped} skipped\n`);
    }

    process.stdout.write(`${num} "${song.title}" — ${song.artist} ... `);

    const result = await fetchItunesThumbnail(song.title, song.artist);

    if (!result.success || !result.url) {
      console.log(`❌ Not found (${result.reason})`);
      stats.failed++;
      stats.failedSongs.push({ title: song.title, artist: song.artist, reason: result.reason });
      await sleep(DELAY_BETWEEN_REQUESTS);
      continue;
    }

    const saved = await updateSongThumbnail(song._id, result.url);
    if (saved) {
      console.log(`✅ Updated (matched: "${result.matchedTrack}" by ${result.matchedArtist})`);
      stats.updated++;
    } else {
      console.log(`❌ DB update failed`);
      stats.failed++;
      stats.failedSongs.push({ title: song.title, artist: song.artist, reason: 'db update failed' });
    }

    await sleep(DELAY_BETWEEN_REQUESTS);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('📋 FINAL SUMMARY');
  console.log('─'.repeat(60));
  console.log(`✅ Successfully updated : ${stats.updated} songs`);
  console.log(`❌ Failed               : ${stats.failed} songs`);
  console.log(`⏭️  Skipped              : ${stats.skipped} songs`);
  console.log(`📦 Total processed      : ${total} songs`);

  if (stats.failedSongs.length > 0) {
    console.log('\n⚠️  Songs that could not be updated:');
    stats.failedSongs.forEach((s) => {
      console.log(`   - "${s.title}" by ${s.artist} (${s.reason})`);
    });
    console.log('\n💡 Tip: For failed songs, check spelling of title/artist in your DB.');
  }

  await mongoose.disconnect();
  console.log('\n🔌 Disconnected. Done!');
}

fixThumbnails().catch((err) => {
  console.error('💥 Fatal error:', err);
  mongoose.disconnect();
  process.exit(1);
});

require('dotenv').config();
const https = require('https');
const mongoose = require('mongoose');
const Song = require('../models/Song');
const User = require('../models/User');

const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID || '34d97c8e';
const DELAY = 500; // ms between API calls
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Genre/language buckets to fetch
const QUERIES = [
  { tags: 'pop',       language: 'english', genre: 'Pop',       limit: 12, featured: true  },
  { tags: 'hiphop',    language: 'english', genre: 'Hip Hop',   limit: 10, featured: true  },
  { tags: 'rnb',       language: 'english', genre: 'R&B',       limit: 8,  featured: true  },
  { tags: 'indie',     language: 'english', genre: 'Indie',     limit: 8,  featured: false },
  { tags: 'classical', language: 'english', genre: 'Classical', limit: 6,  featured: false },
  { tags: 'rock',      language: 'english', genre: 'Rock',      limit: 6,  featured: false },
  { tags: 'latin',     language: 'spanish', genre: 'Latin Pop', limit: 10, featured: true  },
  { tags: 'pop',       language: 'spanish', genre: 'Pop',       limit: 6,  featured: false },
  { tags: 'bollywood', language: 'hindi',   genre: 'Bollywood', limit: 8,  featured: true  },
  { tags: 'indian',    language: 'hindi',   genre: 'Indie Pop', limit: 6,  featured: false },
  { tags: 'kpop',      language: 'korean',  genre: 'K-Pop',     limit: 8,  featured: true  },
  { tags: 'asian',     language: 'korean',  genre: 'K-Pop',     limit: 4,  featured: false },
  { tags: 'punjabi',   language: 'punjabi', genre: 'Punjabi Pop', limit: 8, featured: true },
];

function fetchJamendo(tags, limit, offset = 0) {
  return new Promise((resolve) => {
    const url =
      `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}` +
      `&format=json&limit=${limit}&offset=${offset}` +
      `&tags=${encodeURIComponent(tags)}` +
      `&include=musicinfo&imagesize=500` +
      `&audioformat=mp32&order=popularity_total`;

    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.results || []);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
  });
}

async function seed() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected.\n');

  const user = await User.findOne();
  if (!user) {
    console.error('❌ No user found in DB. Create a user first.');
    await mongoose.disconnect();
    return;
  }
  console.log(`👤 Seeding as user: ${user.name}\n`);

  // Collect existing URLs to avoid duplicates
  const existingSongs = await Song.find({}, 'url title');
  const existingUrls = new Set(existingSongs.map((s) => s.url));
  const existingTitles = new Set(existingSongs.map((s) => s.title.toLowerCase()));
  console.log(`📦 ${existingSongs.length} songs already in DB — skipping duplicates.\n`);

  const toInsert = [];
  const seen = new Set(); // track within this run

  for (const q of QUERIES) {
    console.log(`🔍 Fetching "${q.tags}" (${q.language}, ${q.genre}, limit ${q.limit})...`);
    const tracks = await fetchJamendo(q.tags, q.limit + 10); // fetch extra to account for filtered ones
    await sleep(DELAY);

    let added = 0;
    for (const track of tracks) {
      if (added >= q.limit) break;

      const audioUrl = track.audio || track.audiodownload;
      const thumbnail = track.album_image || track.image || '';
      const title = track.name;
      const artist = track.artist_name;
      const duration = track.duration ? Math.round(track.duration) : 200;

      // Skip if missing essentials
      if (!audioUrl || !title || !artist) continue;

      // Skip duplicates
      if (existingUrls.has(audioUrl)) continue;
      if (existingTitles.has(title.toLowerCase())) continue;
      if (seen.has(audioUrl)) continue;

      seen.add(audioUrl);

      toInsert.push({
        title,
        artist,
        album: track.album_name || '',
        genre: q.genre,
        language: q.language,
        duration,
        url: audioUrl,
        thumbnail: thumbnail || 'https://via.placeholder.com/500x500/1a1a2e/ffffff?text=🎵',
        featured: q.featured,
        uploadedBy: user._id,
        lyrics: '',
      });

      added++;
    }

    console.log(`   ✅ ${added} songs queued from this batch.`);
  }

  if (toInsert.length === 0) {
    console.log('\n⚠️  No new songs to insert (all already exist or API returned nothing).');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n💾 Inserting ${toInsert.length} new songs into MongoDB...`);

  // Insert in batches of 20 to avoid overwhelming the DB
  const BATCH = 20;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    try {
      await Song.insertMany(batch, { ordered: false });
      inserted += batch.length;
      console.log(`   📀 ${inserted}/${toInsert.length} inserted...`);
    } catch (err) {
      // ordered: false means it continues even if some duplicates sneak through
      const writeErrors = err.writeErrors?.length || 0;
      inserted += batch.length - writeErrors;
      if (writeErrors > 0) console.log(`   ⚠️  ${writeErrors} skipped (duplicate url)`);
    }
  }

  const finalCount = await Song.countDocuments();

  console.log('\n' + '═'.repeat(55));
  console.log('🎉 SEEDING COMPLETE');
  console.log('═'.repeat(55));
  console.log(`✅ New songs inserted : ${inserted}`);
  console.log(`📦 Total songs in DB  : ${finalCount}`);
  console.log('\nLanguage breakdown:');
  const langs = ['english', 'spanish', 'hindi', 'korean', 'punjabi'];
  for (const lang of langs) {
    const count = await Song.countDocuments({ language: lang });
    console.log(`   ${lang.padEnd(10)}: ${count} songs`);
  }

  console.log('\n💡 Run fix-thumbnails.js next to upgrade any missing artwork:');
  console.log('   node scripts/fix-thumbnails.js\n');

  await mongoose.disconnect();
  console.log('🔌 Disconnected. Done!');
}

seed().catch((err) => {
  console.error('💥 Fatal error:', err.message);
  mongoose.disconnect();
  process.exit(1);
});

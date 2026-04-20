const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { exec } = require("child_process");
const Groq = require("groq-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// Create folders
["uploads", "outputs", "temp"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// API Keys from environment
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Init Groq
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Init Supabase (admin)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Multer upload
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ElevenLabs Voice IDs
const VOICES = {
  Hindi: "pNInz6obpgDQGcFmaJgB",
  English: "21m00Tcm4TlvDq8ikWAM",
  French: "MF3mGyEYCl7XYWbV9V6O",
  German: "TxGEqnHWrfWFTfGW9XjX",
  Spanish: "AZnzlk1XvdvUeBnXmlld",
  Portuguese: "yoZ06aMxZJJ2&mfd3POQ",
  Russian: "pNInz6obpgDQGcFmaJgB",
  Chinese: "pNInz6obpgDQGcFmaJgB",
  Japanese: "pNInz6obpgDQGcFmaJgB",
  Korean: "pNInz6obpgDQGcFmaJgB",
  Arabic: "pNInz6obpgDQGcFmaJgB",
  Italian: "onwK4e9ZLuTAKqWW03F9",
  default: "21m00Tcm4TlvDq8ikWAM",
};

function run(cmd) {
  return new Promise((ok, fail) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) fail(new Error(stderr || err.message));
      else ok(out);
    });
  });
}

// ─── SIGNUP ───────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true, user: data.user });
});

// ─── LOGIN ────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true, user: data.user, session: data.session });
});

// ─── GET SAVED VIDEOS ─────────────────────────────────────
app.get("/api/saved-videos", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not logged in" });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError) return res.status(401).json({ error: "Invalid session" });

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .eq("user_id", userData.user.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ videos: data });
});

// ─── CHECK VIDEO COUNT ────────────────────────────────────
app.get("/api/video-count", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not logged in" });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError) return res.status(401).json({ error: "Invalid session" });

  const { count, error } = await supabase
    .from("videos")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userData.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0, remaining: Math.max(0, 5 - (count || 0)) });
});

// ─── DUB VIDEO ────────────────────────────────────────────
app.post("/api/dub", upload.single("video"), async (req, res) => {
  const lang = req.body.language || "Hindi";
  const videoUrl = req.body.videoUrl;
  let videoPath = null;
  const cleanup = [];

  try {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing!");
    if (!ELEVEN_KEY) throw new Error("ELEVENLABS_API_KEY missing!");

    // ── Auth check ──
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) throw new Error("Please login first");

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError) throw new Error("Invalid session, please login again");

    const userId = userData.user.id;

    // ── Check 5 video limit ──
    const { count } = await supabase
      .from("videos")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    if ((count || 0) >= 5) {
      throw new Error("Free limit reached! You have used all 5 free videos. Please upgrade to continue.");
    }

    // ── Get video ──
    if (req.file) {
      videoPath = req.file.path;
      cleanup.push(videoPath);
    } else if (videoUrl) {
      videoPath = `uploads/dl_${Date.now()}.mp4`;
      cleanup.push(videoPath);
      const resp = await axios.get(videoUrl, { responseType: "stream" });
      const writer = fs.createWriteStream(videoPath);
      await new Promise((ok, fail) => {
        resp.data.pipe(writer);
        writer.on("finish", ok);
        writer.on("error", fail);
      });
    } else {
      return res.status(400).json({ error: "No video file or URL provided" });
    }

    // ── Extract audio ──
    const audioPath = `temp/audio_${Date.now()}.mp3`;
    cleanup.push(audioPath);
    await run(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -vn "${audioPath}" -y`);

    // ── Transcribe with Groq Whisper ──
    const audioStream = fs.createReadStream(audioPath);
    const transcription = await groq.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-large-v3",
      response_format: "json",
    });
    const originalText = transcription.text;

    // ── Translate with Groq LLaMA ──
    const translation = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `Translate to ${lang}. Return ONLY the translated text, nothing else.`,
        },
        { role: "user", content: originalText },
      ],
      temperature: 0.3,
    });
    const translatedText = translation.choices[0].message.content.trim();

    // ── Text to Speech with ElevenLabs ──
    const voiceId = VOICES[lang] || VOICES.default;
    const dubbedAudioPath = `temp/dubbed_${Date.now()}.mp3`;
    cleanup.push(dubbedAudioPath);

    const elevenResp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: translatedText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          "xi-api-key": ELEVEN_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
      }
    );
    fs.writeFileSync(dubbedAudioPath, Buffer.from(elevenResp.data));

    // ── Merge video + dubbed audio ──
    const outFile = `dubbed_${Date.now()}.mp4`;
    const outPath = `outputs/${outFile}`;
    await run(
      `ffmpeg -i "${videoPath}" -i "${dubbedAudioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest "${outPath}" -y`
    );
    cleanup.forEach((f) => { try { fs.unlinkSync(f); } catch {} });

    const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const videoFinalUrl = `${proto}://${host}/outputs/${outFile}`;

    // ── Save to Supabase ──
    await supabase.from("videos").insert({
      user_id: userId,
      video_url: videoFinalUrl,
      original_text: originalText,
      translated_text: translatedText,
      language: lang,
    });

    res.json({
      success: true,
      videoUrl: videoFinalUrl,
      originalText,
      translatedText,
      language: lang,
      sizeMB: size,
    });

  } catch (err) {
    cleanup.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    groq: GROQ_API_KEY ? "✅ Connected" : "❌ Missing",
    elevenlabs: ELEVEN_KEY ? "✅ Connected" : "❌ Missing",
    supabase: SUPABASE_URL ? "✅ Connected" : "❌ Missing",
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Dubee.ai running on port ${PORT}`);
  console.log(`Groq: ${GROQ_API_KEY ? "✅" : "❌ Missing"}`);
  console.log(`ElevenLabs: ${ELEVEN_KEY ? "✅" : "❌ Missing"}`);
  console.log(`Supabase: ${SUPABASE_URL ? "✅" : "❌ Missing"}`);
});


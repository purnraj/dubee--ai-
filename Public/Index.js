 // ============================================================
// Dubee.ai — Replit Backend Server
// OpenAI Whisper + GPT-4o + ElevenLabs + FFmpeg
// ============================================================

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { exec } = require("child_process");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// ── Serve frontend files ──────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Serve output videos ───────────────────────────────────
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// ── Create folders ────────────────────────────────────────
["uploads", "outputs", "temp"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── API KEYS — Replit Secrets se aate hain ────────────────
// Replit mein: Tools → Secrets mein add karo
// OPENAI_API_KEY aur ELEVENLABS_API_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ── File Upload Config ────────────────────────────────────
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// ── ElevenLabs Voice IDs (Multilingual v2 model) ──────────
// Ye voice IDs ElevenLabs ke free voices hain
const VOICES = {
  Hindi:      "pNInz6obpgDQGcFmaJgB", // Adam — works for Hindi
  English:    "21m00Tcm4TlvDq8ikWAM", // Rachel
  Spanish:    "AZnzlk1XvdvUeBnXmlld", // Domi
  French:     "MF3mGyEYCl7XYWbV9V6O", // Elli
  German:     "TxGEqnHWrfWFTfGW9XjX", // Josh
  Portuguese: "yoZ06aMxZJJ28mfd3POQ", // Sam
  Italian:    "onwK4e9ZLuTAKqWW03F9", // Daniel
  Russian:    "pNInz6obpgDQGcFmaJgB", // Adam
  Chinese:    "pNInz6obpgDQGcFmaJgB", // Adam
  Japanese:   "pNInz6obpgDQGcFmaJgB", // Adam
  Korean:     "pNInz6obpgDQGcFmaJgB", // Adam
  Arabic:     "pNInz6obpgDQGcFmaJgB", // Adam
  default:    "21m00Tcm4TlvDq8ikWAM", // Rachel fallback
};

// ── Helper: Shell command ─────────────────────────────────
function run(cmd) {
  return new Promise((ok, fail) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) fail(new Error(stderr || err.message));
      else ok(out);
    });
  });
}

// ── Install FFmpeg on Replit (auto) ──────────────────────
async function ensureFFmpeg() {
  try {
    await run("ffmpeg -version");
  } catch {
    console.log("FFmpeg install ho raha hai...");
    await run("apt-get install -y ffmpeg 2>/dev/null || nix-env -iA nixpkgs.ffmpeg 2>/dev/null || true");
  }
}

// ── MAIN: /api/dub endpoint ───────────────────────────────
app.post("/api/dub", upload.single("video"), async (req, res) => {
  const lang = req.body.language || "Hindi";
  const videoUrl = req.body.videoUrl;
  let videoPath = null;
  const cleanup = [];

  try {
    // ── Check API keys ─────────────────────────────────
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY set nahi hai! Replit Secrets mein add karo.");
    if (!ELEVEN_KEY) throw new Error("ELEVENLABS_API_KEY set nahi hai! Replit Secrets mein add karo.");

    await ensureFFmpeg();

    // ── STEP 1: Video file lo ──────────────────────────
    if (req.file) {
      videoPath = req.file.path;
      cleanup.push(videoPath);
      console.log("✅ File upload mila:", req.file.originalname);
    } else if (videoUrl) {
      videoPath = `uploads/dl_${Date.now()}.mp4`;
      cleanup.push(videoPath);
      // Direct MP4 URL download
      const resp = await axios.get(videoUrl, { responseType: "stream" });
      const writer = fs.createWriteStream(videoPath);
      await new Promise((ok, fail) => {
        resp.data.pipe(writer);
        writer.on("finish", ok);
        writer.on("error", fail);
      });
      console.log("✅ Video download hua:", videoUrl);
    } else {
      return res.status(400).json({ error: "Video file ya URL dono mein se kuch bhi nahi mila" });
    }

    // ── STEP 2: Audio extract karo ─────────────────────
    const audioPath = `temp/audio_${Date.now()}.mp3`;
    cleanup.push(audioPath);
    await run(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -vn "${audioPath}" -y`);
    console.log("✅ Audio extract ho gaya");

    // ── STEP 3: Whisper se transcribe karo ────────────
    const audioStream = fs.createReadStream(audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-1",
      response_format: "json",
    });
    const originalText = transcription.text;
    console.log("✅ Transcription:", originalText.substring(0, 100) + "...");

    // ── STEP 4: GPT-4o se translate karo ──────────────
    const translation = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a professional video dubbing translator. 
Translate to ${lang}. Rules:
- Natural spoken language (not written/formal)
- Match the emotional tone
- Keep it concise for dubbing
- Return ONLY the translated text`,
        },
        { role: "user", content: originalText },
      ],
      temperature: 0.3,
    });
    const translatedText = translation.choices[0].message.content.trim();
    console.log("✅ Translation:", translatedText.substring(0, 100) + "...");

    // ── STEP 5: ElevenLabs se dubbed audio banao ──────
    const voiceId = VOICES[lang] || VOICES.default;
    const dubbedAudioPath = `temp/dubbed_${Date.now()}.mp3`;
    cleanup.push(dubbedAudioPath);

    const elevenResp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: translatedText,
        model_id: "eleven_multilingual_v2", // 29+ languages support
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
    console.log("✅ Dubbed audio ban gaya");

    // ── STEP 6: Audio + Video merge karo ──────────────
    const outFile = `dubbed_${Date.now()}.mp4`;
    const outPath = `outputs/${outFile}`;
    await run(
      `ffmpeg -i "${videoPath}" -i "${dubbedAudioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest "${outPath}" -y`
    );
    console.log("✅ Video merge ho gaya:", outFile);

    // ── Cleanup temp files ─────────────────────────────
    cleanup.forEach((f) => { try { fs.unlinkSync(f); } catch {} });

    // ── Response bhejo ────────────────────────────────
    const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-replit-dev-domain"] || req.headers.host;
    const videoFinalUrl = `https://${host}/outputs/${outFile}`;

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
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    openai: !!OPENAI_KEY ? "✅ Connected" : "❌ Missing",
    elevenlabs: !!ELEVEN_KEY ? "✅ Connected" : "❌ Missing",
  });
});

// ── Sabhi routes frontend ko bhejo ────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎙 Dubee.ai server chal raha hai port ${PORT} par`);
  console.log(`OpenAI: ${OPENAI_KEY ? "✅" : "❌ Missing"}`);
  console.log(`ElevenLabs: ${ELEVEN_KEY ? "✅" : "❌ Missing"}`);
});

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { exec } = require("child_process");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// Frontend files
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// Create folders
["uploads", "outputs", "temp"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_KEY });

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 200 * 1024 * 1024 },
});

const VOICES = {
  Hindi: "pNInz6obpgDQGcFmaJgB",
  English: "21m00Tcm4TlvDq8ikWAM",
  Spanish: "AZnzlk1XvdvUeBnXmlld",
  French: "MF3mGyEYCl7XYWbV9V6O",
  German: "TxGEqnHWrfWFTfGW9XjX",
  Portuguese: "yoZ06aMxZJJ28mfd3POQ",
  Italian: "onwK4e9ZLuTAKqWW03F9",
  Russian: "pNInz6obpgDQGcFmaJgB",
  Chinese: "pNInz6obpgDQGcFmaJgB",
  Japanese: "pNInz6obpgDQGcFmaJgB",
  Korean: "pNInz6obpgDQGcFmaJgB",
  Arabic: "pNInz6obpgDQGcFmaJgB",
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

app.post("/api/dub", upload.single("video"), async (req, res) => {
  const lang = req.body.language || "Hindi";
  const videoUrl = req.body.videoUrl;
  let videoPath = null;
  const cleanup = [];

  try {
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing!");
    if (!ELEVEN_KEY) throw new Error("ELEVENLABS_API_KEY missing!");

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
      return res.status(400).json({ error: "Video file ya URL nahi mila" });
    }

    const audioPath = `temp/audio_${Date.now()}.mp3`;
    cleanup.push(audioPath);
    await run(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -vn "${audioPath}" -y`);

    const audioStream = fs.createReadStream(audioPath);
    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-1",
      response_format: "json",
    });
    const originalText = transcription.text;

    const translation = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Translate to ${lang}. Return ONLY the translated text.`,
        },
        { role: "user", content: originalText },
      ],
      temperature: 0.3,
    });
    const translatedText = translation.choices[0].message.content.trim();

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

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    openai: OPENAI_KEY ? "✅ Connected" : "❌ Missing",
    elevenlabs: ELEVEN_KEY ? "✅ Connected" : "❌ Missing",
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎙 Dubee.ai running on port ${PORT}`);
  console.log(`OpenAI: ${OPENAI_KEY ? "✅" : "❌ Missing"}`);
  console.log(`ElevenLabs: ${ELEVEN_KEY ? "✅" : "❌ Missing"}`);
});


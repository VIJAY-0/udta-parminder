import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API to scan audio folders
  app.get("/api/audio", (req, res) => {
    const audioRoot = path.join(process.cwd(), "public", "assets", "audio");
    const result: Record<string, string[]> = {
      start: [],
      bg: [],
      click: [],
      gameover: [],
    };

    try {
      const categories = ["start", "bg", "click", "gameover"];
      categories.forEach((cat) => {
        const catPath = path.join(audioRoot, cat);
        if (fs.existsSync(catPath)) {
          const files = fs.readdirSync(catPath);
          result[cat] = files
            .filter((f) => f.endsWith(".mp3") || f.endsWith(".ogg") || f.endsWith(".wav"))
            .map((f) => `/assets/audio/${cat}/${f}`);
        }
      });
      res.json(result);
    } catch (error) {
      console.error("Error scanning audio:", error);
      res.status(500).json({ error: "Failed to scan audio" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

import fs from "fs";
import path from "path";

const audioRoot = path.join(process.cwd(), "public", "assets", "audio");
const outputFile = path.join(process.cwd(), "public", "audio-manifest.json");

const result = {
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

  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log("Audio manifest generated successfully at public/audio-manifest.json");
} catch (error) {
  console.error("Error generating audio manifest:", error);
  process.exit(1);
}

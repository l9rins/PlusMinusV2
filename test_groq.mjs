import fs from 'node:fs';
const mmdd = "05-08";
const dateLabel = "May 8";
const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
  },
  body: JSON.stringify({
    model: 'llama-3.1-8b-instant',
    max_tokens: 1000,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `You generate NBA "On This Day" historical moments. You MUST return ONLY valid JSON — no markdown, no preamble, no backticks.\nReturn exactly this structure:\n[\n  {\n    "date_mmdd": "${mmdd}",\n    "year": 2006,\n    "color": "var(--lime)",\n    "tag": "RECORD",\n    "tagIcon": "trending-up",\n    "headline": "Short punchy headline under 12 words",\n    "detail": "2-3 sentence factual detail about the event.",\n    "statChip": { "cls": "up", "text": "81 PTS" },\n    "players": ["Player Name"]\n  }\n]\nRules:\n- Return EXACTLY 3 items. Always 3, never more, never less.\n- Every item date_mmdd must equal "${mmdd}" exactly.\n- Every event must have occurred on ${dateLabel} in its year.\n- color must be one of: "var(--lime)", "var(--coral)", "var(--amber)", "var(--blue)"\n- tagIcon must be one of: "zap", "trending-up", "star", "crown", "flame", "trophy"\n- tag must be one of: RECORD, MILESTONE, DEBUT, DYNASTY, COMEBACK, PLAYOFFS, FAREWELL\n- statChip.cls must be "up" or "down"\n- All facts must be 100% accurate NBA history\n- Vary the colors and tags across the 3 items\n- Players array: 1-3 names max`
      },
      {
        role: 'user',
        content: `Search for real historical NBA moments that happened specifically on ${dateLabel} in any year. Focus on records, legendary performances, milestones, championships, and iconic debuts. Return ONLY the JSON array, and leave the array empty if you cannot verify three date-matched events.`
      }
    ]
  })
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));

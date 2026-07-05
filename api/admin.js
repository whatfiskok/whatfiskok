export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyUse8PHFkFTPB5tyLyJ4HIltaiQrKFlq_E93JuSFlwyH15TuS-xEe6Vuxemcq4w6gE/exec';

  
  try {
    const response = await fetch(SHEETS_URL);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

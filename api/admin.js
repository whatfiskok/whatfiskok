export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwY6AV3DADM23UsuKB31BY8zDc02-p6GADL9JBA2TxkOQqGTowtD5_QkGgfLY10toam/exec';
  
  try {
    const response = await fetch(SHEETS_URL);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

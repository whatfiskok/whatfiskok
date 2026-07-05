export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycby1EntjYtDk5bY5Oj23xgMe_-ns1ZkX8qcLVqLHntnqIEo7v1CzpcrzS5LxWtl8MPFX/exec';

  
  try {
    const response = await fetch(SHEETS_URL);
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Ключ ScraperAPI: из .env (SCRAPER_API_KEY) или из «Настроек» — общее хранилище ключей в utils/secrets.js
const { secret, secretFromEnv, setSavedSecret } = require('./secrets.js');

const scraperKey = () => secret('scraper');
const setSavedScraperKey = (key) => setSavedSecret('scraper', key);
const scraperKeyFromEnv = () => secretFromEnv('scraper');

module.exports = { scraperKey, setSavedScraperKey, scraperKeyFromEnv };

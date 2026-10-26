const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { execFile } = require('child_process');
const execFilePromise = util.promisify(execFile);
const { AUDIOCACHE, EXTRACT_TMP } = require('../config/index.js');
const { mediaKey } = require('../utils/gameData.js');

class AudioService {
    async decryptRpgmvo(filePath, gamePath) {
        const fileData = await fsp.readFile(filePath);
        if (fileData.slice(0, 4).toString('ascii') !== 'RPGM') return fileData;

        // Ключ — из System.json, а если игра его спрятала (данные в AES) — из её картинок (utils/gameData.js)
        let encKey = '';
        try {
            const root = fs.existsSync(path.join(gamePath, 'data', 'System.json')) || !fs.existsSync(path.join(gamePath, 'www')) ? gamePath : path.join(gamePath, 'www');
            encKey = await mediaKey(root);
        } catch(e) {}

        const keyBytes = [];
        for (let i = 0; i < encKey.length; i += 2) keyBytes.push(parseInt(encKey.substr(i, 2), 16));

        const out = Buffer.from(fileData.subarray(16));
        if (keyBytes.length === 0) return out;

        for (let i = 0; i < 16 && i < out.length; i++) out[i] ^= keyBytes[i % keyBytes.length];
        return out;
    }

    async ensureM4aFromSource(sourcePath, gamePath) {
        const stat = await fsp.stat(sourcePath);
        const cacheKey = crypto.createHash('sha1').update(sourcePath + '|' + stat.mtimeMs).digest('hex');
        const outPath = path.join(AUDIOCACHE, cacheKey + '.m4a');
        
        try { await fsp.access(outPath); return outPath; } catch {} 

        const ext = path.extname(sourcePath).toLowerCase();
        if (ext === '.m4a') return sourcePath;
        if (ext === '.rpgmvm') {
            await fsp.writeFile(outPath, await this.decryptRpgmvo(sourcePath, gamePath));
            return outPath;
        }

        const tmpIn = path.join(EXTRACT_TMP, cacheKey + (ext === '.rpgmvo' ? '.ogg' : ext));
        await fsp.writeFile(tmpIn, ext === '.rpgmvo' ? await this.decryptRpgmvo(sourcePath, gamePath) : await fsp.readFile(sourcePath));

        try {
            await execFilePromise('ffmpeg', ['-y', '-i', tmpIn, '-vn', '-c:a', 'aac', '-b:a', '128k', outPath]);
            return outPath;
        } finally {
            await fsp.unlink(tmpIn).catch(() => {});
        }
    }
}

module.exports = new AudioService();

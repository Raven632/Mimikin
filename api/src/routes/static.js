const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const audioService = require('../services/audio.js'); // Тот самый сервис с FFmpeg
const { findGameFolder } = require('../utils/archive.js');
const { GAMES_DIR } = require('../config/index.js');

const router = express.Router();

router.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/') return next();

    let reqPath = decodeURIComponent(req.path);
    let filePath = path.join(GAMES_DIR, reqPath);

    const normalizedGamesDir = path.resolve(GAMES_DIR);
    const normalizedFilePath = path.resolve(filePath);
    if (normalizedFilePath !== normalizedGamesDir && !normalizedFilePath.startsWith(normalizedGamesDir + path.sep)) {
        return res.status(403).send('Доступ запрещен');
    }

    try {
        if (!fs.existsSync(filePath)) {
            const dir = path.dirname(filePath);
            const baseLow = path.basename(filePath).toLowerCase();
            try {
                const match = fs.readdirSync(dir).find(f => f.toLowerCase() === baseLow);
                if (match) {
                    filePath = path.join(dir, match);
                    reqPath = path.relative(GAMES_DIR, filePath);
                }
            } catch(e) {}
        }

        let stat;
        try { stat = await fsp.stat(filePath); } catch(e) {}

        if (stat && stat.isDirectory()) {
            if (!req.path.endsWith('/')) return res.redirect(req.path + '/');
            if (fs.existsSync(path.join(filePath, 'index.html'))) {
                filePath = path.join(filePath, 'index.html');
            } else if (fs.existsSync(path.join(filePath, 'www', 'index.html'))) {
                return res.redirect(req.path + 'www/');
            } else {
                const deepDir = await findGameFolder(filePath);
                if (deepDir) return res.redirect('/' + path.relative(GAMES_DIR, deepDir).replace(/\\/g, '/') + '/');
                return res.status(404).send(`<div style="color:red; text-align:center; padding:50px;">index.html не найден.</div>`);
            }
        }

        // ========================================================================
        // ВОЗВРАЩЕНО ИЗ ТВОЕГО ОРИГИНАЛЬНОГО КОДА:
        // FFmpeg конвертация, которая дает идеальную совместимость с iOS
        // ========================================================================
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.m4a' || ext === '.ogg') {
            const base = filePath.slice(0, -4);
            const ua = req.headers['user-agent'] || '';
            const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && ua.includes('Mobile'));
            
            const pathsToTry = ext === '.m4a' 
                ? [filePath, base + '.ogg', filePath + '_', base + '.rpgmvo', base + '.rpgmvm'] 
                : [filePath, base + '.m4a', filePath + '_', base + '.rpgmvm', base + '.rpgmvo']; 

            let sourcePath = null;
            for (const p of pathsToTry) {
                try { await fsp.access(p); sourcePath = p; break; } catch {}
            }

            if (sourcePath) {
                const isEncrypted = sourcePath.endsWith('.rpgmvo') || sourcePath.endsWith('.rpgmvm');
                if (isIOS && (isEncrypted || sourcePath.endsWith('.ogg'))) {
                    try {
                        const gameFolder = reqPath.split('/').filter(Boolean)[0];
                        // Снова используем надежный FFmpeg с кэшированием
                        const readyPath = await audioService.ensureM4aFromSource(sourcePath, path.join(GAMES_DIR, gameFolder));
                        res.type('audio/mp4');
                        res.setHeader('Cache-Control', 'public, max-age=86400');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.sendFile(readyPath);
                    } catch (err) { filePath = sourcePath; } 
                } else {
                    filePath = sourcePath;
                }
            }
        }

        let finalStat;
        try { finalStat = await fsp.stat(filePath); } catch(e) {}

        if (finalStat && finalStat.isFile()) {
            if (filePath.endsWith('index.html')) {
                let html = await fsp.readFile(filePath, 'utf8');
                html = html.replace(/<meta[^>]+http-equiv=['"]?Content-Security-Policy['"]?[^>]*>/gi, '');
                html = html.replace(/(<body[^>]*>)/i, '$1<script src="/rpg-fixes.js?v=' + Date.now() + '"></script>');
                res.setHeader('Content-Type', 'text/html');
                res.setHeader('Access-Control-Allow-Origin', '*');
                return res.send(html);
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.sendFile(filePath);
        }
    } catch(e) {}
    next();
});

module.exports = router;

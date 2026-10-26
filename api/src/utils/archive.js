const { spawn } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');

function spawnExtract(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { if (stderr.length < 50000) stderr += d.toString(); });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}. Stderr: ${stderr.slice(0, 2000)}`)));
        proc.on('error', err => reject(new Error(`Запуск ${cmd} не удался: ${err.message}`)));
    });
}

async function findGameFolder(dir, depth = 0) {
    if (depth > 10) return null;
    const items = await fsp.readdir(dir, { withFileTypes: true });
    if (items.some(i => i.isDirectory() && i.name.toLowerCase() === 'www')) return path.join(dir, items.find(i => i.name.toLowerCase() === 'www').name);
    if (items.some(i => i.isFile() && i.name.toLowerCase() === 'index.html')) return dir;
    for (const item of items) {
        if (item.isDirectory()) {
            const found = await findGameFolder(path.join(dir, item.name), depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// Добавь эти импорты в самый верх файла archive.js, если их там нет:
const util = require('util');
const { execFile } = require('child_process');
const execFilePromise = util.promisify(execFile);

// ================= СТАЛО =================
// Нативный и мгновенный Linux-метод подсчета размера
async function getFolderSize(dirPath) {
    try {
        const { stdout } = await execFilePromise('du', ['-sb', dirPath]);
        return parseInt(stdout.split('\t')[0], 10);
    } catch (e) {
        console.error('[Size] Ошибка нативного подсчета:', e);
        return 0;
    }
}

// Игра не на MV/MZ — на каком она движке, по её файлам: чтобы ошибка сказала прямо, а не «нет папки www».
// '' — не узнали. Смотрим сам архив и три уровня папок под ним: игра лежит в первой-второй.
// VX Ace/VX/XP — и упакованные (.rgss3a), и открытые (Data/*.rvdata2, переводы и репаки)
const ENGINES = [
    [/\.rgss(3a|2a|ad)$|^rgss\d+\w*\.dll$|\.(rvdata2?|rxdata)$|^game\.rvproj2?$/i, 'RPG Maker VX Ace, VX или XP'],
    [/^rpg_rt\.(exe|ldb|lmt)$/i, 'RPG Maker 2000 или 2003'],
    [/\.wolf$/i, 'WOLF RPG Editor'],
    [/^renpy$|\.rpa$/i, "Ren'Py"],
    [/^unityplayer\.dll$|^globalgamemanagers$/i, 'Unity'],
    [/\.xp3$/i, 'KiriKiri'],
];
async function otherEngine(dir, depth = 0) {
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
        const hit = ENGINES.find(([re]) => re.test(item.name));
        if (hit) return hit[1];
    }
    if (depth >= 3) return '';
    for (const item of items) {
        if (!item.isDirectory()) continue;
        const found = await otherEngine(path.join(dir, item.name), depth + 1);
        if (found) return found;
    }
    return '';
}

module.exports = { spawnExtract, findGameFolder, getFolderSize, otherEngine };

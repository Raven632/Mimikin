#!/usr/bin/env node
// Забытый пароль: docker exec -it <контейнер> node scripts/reset-password.js [имя]. Без имени — главный администратор, с именем — человек
// из его списка (сброшенному придётся выбрать свой пароль при входе). Другого выхода, кроме базы без учётной
// записи, у человека нет. Пароль — только с терминала без эха или из stdin (для своих скриптов): в аргументах он
// остался бы в истории оболочки и в списке процессов. Сервер при этом работает: запись в базу ждёт его не дольше
// пяти секунд, а стёртые входы он замечает сам (db/database.js, followAccount)
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { GAMES_DIR } = require('../src/config/index.js');
const { resetPassword, accountNamed } = require('../src/utils/account.js');

const stop = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

// Спросить без эха. Подсказки — в stderr: в stdout остаётся только строка об успехе
function askHidden(prompt) {
    return new Promise((resolve, reject) => {
        const { stdin, stderr } = process;
        // Сначала эхо выключить, потом спрашивать: иначе ответ, пришедший сразу за подсказкой, успевает попасть на экран
        stdin.setRawMode(true);
        stderr.write(prompt);
        stdin.setEncoding('utf8');
        stdin.resume();
        let text = '';
        const finish = (settle, value) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            stderr.write('\n');
            settle(value);
        };
        function onData(chunk) {
            // Стрелки и другие управляющие клавиши приходят одной пачкой с Esc: в пароль им нельзя
            if (chunk[0] === '\u001b') return;
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') return finish(resolve, text);
                if (ch === '\u0003' || ch === '\u0004') return finish(reject, Object.assign(new Error('Cancelled, the password stays the same.'), { told: true }));
                if (ch === '\u007f' || ch === '\b') text = [...text].slice(0, -1).join('');
                else if (ch >= ' ') text += ch;
            }
        }
        stdin.on('data', onData);
    });
}

// Из своего скрипта: первая строка stdin, перевод строки — не часть пароля
async function readPiped() {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    return text.split(/\r?\n/)[0];
}

async function main() {
    // Имя — единственный аргумент. Пароль в аргументах не берём, и его не отличить от имени: для пароля, набранного сюда по
    // привычке, найдётся «нет такой записи» — до того, как скрипт что-то спросит
    if (process.argv.length > 3) stop('Usage: node scripts/reset-password.js [name]. Do not put the password on the command line: the script asks for it.');
    const name = process.argv[2] || '';
    const file = path.join(GAMES_DIR, 'library.db');
    if (!fs.existsSync(file)) stop('There is no library.db in the games folder: is this the right container?');
    // docker exec входит под root, а сервер работает под владельцем базы. Файлы, заведённые здесь (журнал базы, ключ
    // шифрования), остались бы от root, и сервер больше не смог бы их прочитать
    if (process.getuid?.() === 0) {
        const { uid, gid } = fs.statSync(file);
        if (uid !== 0) { process.setgroups([]); process.setgid(gid); process.setuid(uid); }
    }
    const db = await open({ filename: file, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout = 5000');
    const { person } = await accountNamed(db, name);
    let password;
    if (process.stdin.isTTY) {
        password = await askHidden('New password: ');
        if (password !== await askHidden('Repeat it: ')) stop('The passwords do not match, nothing changed.');
    } else {
        password = await readPiped();
    }
    const { login, others, locked } = await resetPassword(db, password, name);
    await db.close();
    // Временный пароль человека: сменить его он должен при входе (users.must_change)
    process.stdout.write(`Password changed for "${login}". Every device of this account is signed out within a few seconds.${person ? ' They must choose their own password at the next sign-in.' : ''}\n`);
    if (others.length) process.stdout.write(`Other accounts (run the script with a name to reset one): ${others.join(', ')}\n`);
    // Сброс пароля вход не открывает: закрытый остаётся закрытым, пока главный администратор не откроет его в «Настройках»
    if (locked.length) process.stdout.write(`Closed accounts (their sign-in stays closed until opened in Settings): ${locked.join(', ')}\n`);
    process.exit(0);
}

main().catch((e) => stop(e.told ? e.message : `The password was not changed: ${e.message}`));

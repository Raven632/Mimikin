// Замороженные часы для сервера на время записи демо (node --require clock.js server.js). Зачем: в ответах сервера
// полно «сейчас» (когда собрана галерея, «проверено», срок корзины, «сегодня» в днях игры), а запись дважды должна
// давать одни и те же байты. Время стоит на DEMO_NOW; сдвигать его не надо — игр во время записи никто не запускает.
// Таймеры (setTimeout) идут как шли: замораживаются только Date и Date.now
const NOW = Date.parse(process.env.DEMO_NOW || '');
if (Number.isNaN(NOW)) throw new Error('DEMO_NOW — не дата: запись без неё не повторить');

const RealDate = Date;
class FrozenDate extends RealDate {
    constructor(...args) {
        if (args.length === 0) super(NOW);
        else super(...args);
    }

    static now() { return NOW; }
}
global.Date = FrozenDate;

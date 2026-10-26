import { useState, useEffect } from 'react';

export default function StorageMonitor({ t }) {
    const [storage, setStorage] = useState(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        // Компонент показывается только после входа, поэтому запрос уходит уже с кукой
        fetch('/api/storage')
            .then(res => {
                if (!res.ok) throw new Error('Network response was not ok');
                return res.json();
            })
            .then(data => setStorage(data))
            .catch(err => {
                console.error('Ошибка мониторинга:', err);
                setError(true);
            });
    }, []);

    if (error) return <div className="storage-monitor">{t.storage_err}</div>;
    if (!storage) return <div className="storage-monitor">{t.storage_scan}</div>;

    const formatGB = (bytes) => (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';

    return (
        <div className="storage-monitor">
            <span>{t.storage_games} <b>{formatGB(storage.used)}</b></span>
            <span>{t.storage_free} <b>{formatGB(storage.free)}</b></span>
        </div>
    );
}

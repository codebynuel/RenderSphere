export async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
}

export function formatDate(value) {
    if (!value) return 'Unknown date';
    return new Date(value).toLocaleString();
}

export function formatBalance(value) {
    const amount = Number(value || 0);
    return `$${amount.toFixed(2)}`;
}

export function formatUsd(value) {
    const amount = Number(value || 0);
    return amount > 0 && amount < 1 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

export function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number(seconds || 0)));
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    if (minutes <= 0) return `${remainingSeconds}s`;
    return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import {
    AlertTriangle,
    ChevronLeft,
    ChevronRight,
    Download,
    File,
    FileArchive,
    FileImage,
    Folder,
    Search,
    X,
} from 'lucide-react';

const IMAGE_TYPES = {
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

function entryName(entry) {
    return entry.filename.replace(/\\/g, '/').replace(/^\/+/, '');
}

function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function downloadBlob(blob, name) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export default function ArchiveExplorer({ archive, onClose }) {
    const [phase, setPhase] = useState('downloading');
    const [progress, setProgress] = useState(0);
    const [entries, setEntries] = useState([]);
    const [currentPath, setCurrentPath] = useState('');
    const [search, setSearch] = useState('');
    const [selectedEntry, setSelectedEntry] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [extractingPreview, setExtractingPreview] = useState(false);
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);
    const dialogRef = useRef(null);
    const readerRef = useRef(null);
    const previewRequestRef = useRef(0);

    useEffect(() => {
        const controller = new AbortController();
        let mounted = true;

        async function loadArchive() {
            setPhase('downloading');
            setProgress(0);
            setError('');
            setEntries([]);
            setCurrentPath('');
            setSelectedEntry(null);
            setPreviewUrl('');
            setExtractingPreview(false);

            try {
                const response = await fetch(archive.url, {
                    credentials: 'same-origin',
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const responseText = await response.text();
                    let message = `Could not download archive (HTTP ${response.status}).`;
                    try {
                        message = JSON.parse(responseText).error || message;
                    } catch {
                        if (responseText.trim()) message = responseText.trim();
                    }
                    throw new Error(message);
                }

                const totalBytes = Number(response.headers.get('content-length')) || 0;
                const chunks = [];
                let receivedBytes = 0;
                if (response.body) {
                    const streamReader = response.body.getReader();
                    while (true) {
                        const { done, value } = await streamReader.read();
                        if (done) break;
                        chunks.push(value);
                        receivedBytes += value.byteLength;
                        if (mounted && totalBytes > 0) {
                            setProgress(Math.min(100, Math.round((receivedBytes / totalBytes) * 100)));
                        }
                    }
                } else {
                    const blob = await response.blob();
                    chunks.push(blob);
                    receivedBytes = blob.size;
                    if (mounted) setProgress(100);
                }

                if (!mounted) return;
                setPhase('indexing');
                const archiveBlob = new Blob(chunks, { type: 'application/zip' });
                const zipReader = new ZipReader(new BlobReader(archiveBlob));
                readerRef.current = zipReader;
                const archiveEntries = (await zipReader.getEntries()).filter((entry) => !entry.directory);
                if (!mounted) return;
                setEntries(archiveEntries);
                setProgress(100);
                setPhase('ready');
            } catch (loadError) {
                if (!mounted || loadError.name === 'AbortError') return;
                setError(loadError.message || 'Could not open this ZIP archive.');
                setPhase('error');
            }
        }

        loadArchive();
        return () => {
            mounted = false;
            controller.abort();
            if (readerRef.current) {
                readerRef.current.close().catch((closeError) => {
                    console.error('Could not close ZIP archive reader', closeError);
                });
                readerRef.current = null;
            }
        };
    }, [archive.url, retry]);

    useEffect(() => {
        if (!previewUrl) return undefined;
        return () => URL.revokeObjectURL(previewUrl);
    }, [previewUrl]);

    useEffect(() => {
        const dialog = dialogRef.current;
        const getFocusableElements = () => dialog?.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) || [];
        getFocusableElements()[0]?.focus();
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusableElements = getFocusableElements();
            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            if (!firstElement || !lastElement) {
                event.preventDefault();
            } else if (event.shiftKey && document.activeElement === firstElement) {
                event.preventDefault();
                lastElement.focus();
            } else if (!event.shiftKey && document.activeElement === lastElement) {
                event.preventDefault();
                firstElement.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const visibleItems = useMemo(() => {
        const prefix = currentPath ? `${currentPath}/` : '';
        const query = search.trim().toLowerCase();
        const folders = new Map();
        const files = [];

        entries.forEach((entry) => {
            const name = entryName(entry);
            if (!name.startsWith(prefix)) return;
            const remainder = name.slice(prefix.length);
            if (!remainder) return;

            const separatorIndex = remainder.indexOf('/');
            if (separatorIndex >= 0) {
                const folderName = remainder.slice(0, separatorIndex);
                if (!query || folderName.toLowerCase().includes(query)) {
                    folders.set(folderName, {
                        key: `folder:${folderName}`,
                        name: folderName,
                        path: `${currentPath ? `${currentPath}/` : ''}${folderName}`,
                        type: 'folder',
                    });
                }
                return;
            }

            if (!query || remainder.toLowerCase().includes(query)) {
                files.push({
                    entry,
                    key: `file:${name}`,
                    name: remainder,
                    type: 'file',
                });
            }
        });

        return [
            ...Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name)),
            ...files.sort((a, b) => a.name.localeCompare(b.name)),
        ];
    }, [currentPath, entries, search]);

    const pathParts = currentPath ? currentPath.split('/') : [];
    const imageType = selectedEntry ? IMAGE_TYPES[extensionOf(entryName(selectedEntry))] : '';
    const isBusy = phase === 'downloading' || phase === 'indexing' || phase === 'extracting';

    const extractEntry = async (entry, previewImage = false) => {
        const requestId = ++previewRequestRef.current;
        const name = entryName(entry);
        const mimeType = IMAGE_TYPES[extensionOf(name)] || 'application/octet-stream';
        setExtractingPreview(previewImage);
        setPhase('extracting');
        setProgress(0);
        setError('');

        try {
            const blob = await entry.getData(new BlobWriter(mimeType), {
                onprogress: (completed, total) => {
                    if (total > 0) setProgress(Math.min(100, Math.round((completed / total) * 100)));
                },
            });
            if (requestId !== previewRequestRef.current) return;
            setPhase('ready');
            if (previewImage) {
                setPreviewUrl(URL.createObjectURL(blob));
            } else {
                downloadBlob(blob, name.split('/').pop() || 'archive-file');
            }
        } catch (extractError) {
            if (requestId !== previewRequestRef.current) return;
            setError(extractError.message || `Could not extract ${name}.`);
            setPhase('ready');
        }
    };

    const selectEntry = (entry) => {
        previewRequestRef.current += 1;
        setSelectedEntry(entry);
        setPreviewUrl('');
        setError('');
        if (IMAGE_TYPES[extensionOf(entryName(entry))]) {
            extractEntry(entry, true);
        } else {
            setExtractingPreview(false);
            setPhase('ready');
        }
    };

    const navigateToFolder = (path) => {
        previewRequestRef.current += 1;
        setPhase('ready');
        setCurrentPath(path);
        setSelectedEntry(null);
        setPreviewUrl('');
        setError('');
        setExtractingPreview(false);
    };

    const downloadSelectedEntry = () => {
        if (selectedEntry) extractEntry(selectedEntry);
    };

    const close = () => {
        previewRequestRef.current += 1;
        onClose();
    };

    return (
        <div className="archive-explorer-overlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
        }}>
            <section ref={dialogRef} className="archive-explorer" role="dialog" aria-modal="true" aria-labelledby="archive-explorer-title">
                <div
                    className={`archive-top-loader${isBusy && progress === 0 ? ' indeterminate' : ''}${phase === 'error' ? ' failed' : ''}`}
                    role="progressbar"
                    aria-label="Archive download and extraction progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                >
                    <div className="archive-top-loader-fill" style={{ width: isBusy && progress === 0 ? '32%' : `${progress}%` }} />
                </div>
                <header className="archive-explorer-header">
                    <div className="archive-explorer-heading">
                        <span className="archive-explorer-icon"><FileArchive size={19} /></span>
                        <div>
                            <h2 id="archive-explorer-title">Archive explorer</h2>
                            <p title={archive.name}>{archive.name}</p>
                        </div>
                    </div>
                    <button className="button compact-button ghost-button" type="button" onClick={close} aria-label="Close archive explorer">
                        <X size={17} />
                    </button>
                </header>

                <div className="archive-explorer-status" role="status">
                    {phase === 'downloading' && (
                        <span>{progress > 0 ? `Downloading archive · ${progress}%` : 'Downloading archive…'}</span>
                    )}
                    {phase === 'indexing' && <span>Reading archive contents…</span>}
                    {phase === 'extracting' && <span>{extractingPreview ? `Preparing preview · ${progress}%` : `Extracting file · ${progress}%`}</span>}
                    {phase === 'ready' && <span>{entries.length} {entries.length === 1 ? 'file' : 'files'} in archive</span>}
                    {phase === 'error' && <span>Archive could not be opened</span>}
                    <span className="archive-explorer-size">{formatBytes(entries.reduce((size, entry) => size + (entry.uncompressedSize || 0), 0))}</span>
                </div>

                {error && (
                    <div className="archive-explorer-error" role="alert">
                        <AlertTriangle size={17} />
                        <span>{error}</span>
                        {phase === 'error' && (
                            <button className="button compact-button" type="button" onClick={() => setRetry((value) => value + 1)}>
                                Retry
                            </button>
                        )}
                    </div>
                )}

                {phase === 'ready' || phase === 'extracting' || (phase === 'error' && entries.length > 0) ? (
                    <div className="archive-explorer-body">
                        <section className="archive-file-browser" aria-label="Archive files">
                            <div className="archive-browser-toolbar">
                                <div className="archive-breadcrumbs" aria-label="Archive location">
                                    <button type="button" onClick={() => navigateToFolder('')}>
                                        <FileArchive size={14} /> Root
                                    </button>
                                    {pathParts.map((part, index) => {
                                        const path = pathParts.slice(0, index + 1).join('/');
                                        return (
                                            <span className="archive-breadcrumb-part" key={path}>
                                                <ChevronRight size={14} />
                                                <button type="button" onClick={() => navigateToFolder(path)}>{part}</button>
                                            </span>
                                        );
                                    })}
                                </div>
                                <label className="archive-search">
                                    <Search size={15} />
                                    <input
                                        type="search"
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        placeholder="Filter this folder"
                                        aria-label="Filter archive contents"
                                    />
                                </label>
                            </div>
                            {currentPath && (
                                <button
                                    className="archive-up-button"
                                    type="button"
                                    onClick={() => navigateToFolder(pathParts.slice(0, -1).join('/'))}
                                >
                                    <ChevronLeft size={15} /> Up one folder
                                </button>
                            )}
                            <div className="archive-entry-list">
                                {visibleItems.map((item) => {
                                    const Icon = item.type === 'folder' ? Folder
                                        : IMAGE_TYPES[extensionOf(item.name)] ? FileImage
                                            : File;
                                    return item.type === 'folder' ? (
                                        <button className="archive-entry" type="button" key={item.key} onClick={() => navigateToFolder(item.path)}>
                                            <Icon size={17} />
                                            <span className="archive-entry-name">{item.name}</span>
                                            <ChevronRight size={15} />
                                        </button>
                                    ) : (
                                        <button
                                            className={`archive-entry${selectedEntry === item.entry ? ' selected' : ''}`}
                                            type="button"
                                            key={item.key}
                                            onClick={() => selectEntry(item.entry)}
                                        >
                                            <Icon size={17} />
                                            <span className="archive-entry-name">{item.name}</span>
                                            <span className="archive-entry-size">{formatBytes(item.entry.uncompressedSize)}</span>
                                        </button>
                                    );
                                })}
                                {!visibleItems.length && <p className="archive-empty">No files in this folder.</p>}
                            </div>
                        </section>

                        <section className="archive-preview" aria-label="File preview">
                            {previewUrl ? (
                                <img src={previewUrl} alt={entryName(selectedEntry)} />
                            ) : selectedEntry ? (
                                <div className="archive-preview-info">
                                    <span className="archive-preview-file-icon">{imageType ? <FileImage size={26} /> : <File size={26} />}</span>
                                    <h3>{entryName(selectedEntry).split('/').pop()}</h3>
                                    <p>{formatBytes(selectedEntry.uncompressedSize)} · {imageType || 'File preview unavailable'}</p>
                                    <button className="button primary" type="button" onClick={downloadSelectedEntry} disabled={isBusy}>
                                        <Download size={16} /> Extract file
                                    </button>
                                </div>
                            ) : (
                                <div className="archive-preview-empty">
                                    <FileImage size={30} />
                                    <p>Select an image to preview it, or browse folders to explore the archive.</p>
                                </div>
                            )}
                        </section>
                    </div>
                ) : null}
            </section>
        </div>
    );
}

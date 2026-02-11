let deepAnalysisPerformed = false;

// Global error redirection to UI log
window.addEventListener('error', (e) => {
    log(`Script Error: ${e.message}`, 'var(--danger)');
});
window.addEventListener('unhandledrejection', (e) => {
    log(`Promise Error: ${e.reason?.message || e.reason}`, 'var(--danger)');
});

function initCounter() {
    const counterElement = document.getElementById('viewCount');
    const storageKey = 'modpack_merger_views';
    const sessionKey = 'modpack_merger_session';

    if (!sessionStorage.getItem(sessionKey)) {
        let currentCount = parseInt(localStorage.getItem(storageKey) || '0', 10);
        currentCount++;
        localStorage.setItem(storageKey, currentCount.toString());
        sessionStorage.setItem(sessionKey, '1');
    }

    const viewCount = parseInt(localStorage.getItem(storageKey) || '0', 10);
    counterElement.innerText = viewCount.toLocaleString();
    counterElement.style.color = "var(--accent)";
}

class VersionComparator {
    static parse(versionString) {
        const cleaned = versionString.replace(/[^0-9.]/g, '');
        const parts = cleaned.split('.').map(p => parseInt(p) || 0);
        return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: versionString };
    }

    static compare(v1, v2) {
        const p1 = this.parse(v1);
        const p2 = this.parse(v2);
        if (p1.major !== p2.major) return p1.major - p2.major;
        if (p1.minor !== p2.minor) return p1.minor - p2.minor;
        return p1.patch - p2.patch;
    }

    static isNewer(v1, v2) {
        return this.compare(v1, v2) > 0;
    }
}

class JarMetadataExtractor {
    constructor() {
        this.cache = new Map();
    }

    async extract(url, fileName) {
        if (this.cache.has(url)) {
            return this.cache.get(url).metadata;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            const blob = await response.blob();
            const zip = await JSZip.loadAsync(blob);

            const metadata = await this.parseMetadata(zip, fileName);
            this.cache.set(url, { metadata, blob });
            return metadata;
        } catch (err) {
            log(`Failed to analyze mod "${fileName}": ${err.message}`, 'var(--danger)');
            const fallback = { mods: [{ id: fileName, version: 'unknown' }], bundled: [] };
            this.cache.set(url, { metadata: fallback, blob: null });
            return fallback;
        }
    }

    async parseMetadata(zip, fileName) {
        try {
            const fabricMod = zip.file('fabric.mod.json');
            if (fabricMod) return await this.parseFabricMod(fabricMod, zip);

            const forgeMod = zip.file('META-INF/mods.toml');
            if (forgeMod) return await this.parseForgeMod(forgeMod);

            return { mods: [{ id: fileName, version: 'unknown' }], bundled: [] };
        } catch (err) {
            log(`Error parsing metadata for "${fileName}": ${err.message}`, 'var(--danger)');
            return { mods: [{ id: fileName, version: 'unknown' }], bundled: [] };
        }
    }

    async parseFabricMod(file, zip) {
        try {
            const content = await file.async('string');
            const data = JSON.parse(content);

            const mods = [{ id: data.id || 'unknown', version: data.version || 'unknown', name: data.name }];
            const bundled = [];

            if (data.jars && Array.isArray(data.jars)) {
                for (const jar of data.jars) {
                    try {
                        const nestedFile = zip.file(jar.file);
                        if (nestedFile) {
                            const nestedZip = await JSZip.loadAsync(await nestedFile.async('blob'));
                            const nestedMeta = await this.parseMetadata(nestedZip, jar.file);
                            bundled.push(...nestedMeta.mods);
                        }
                    } catch (e) {
                        log(`Warning: Failed to parse bundled JAR "${jar.file}"`, 'var(--warning)');
                    }
                }
            }

            return { mods, bundled };
        } catch (err) {
            log(`Fabric metadata error: ${err.message}`, 'var(--danger)');
            return { mods: [{ id: 'parse_error', version: 'unknown' }], bundled: [] };
        }
    }

    async parseForgeMod(file) {
        try {
            const content = await file.async('string');
            const modIdMatch = content.match(/modId\s*=\s*"([^"]+)"/);
            const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);

            const id = modIdMatch ? modIdMatch[1] : 'unknown';
            const version = versionMatch ? versionMatch[1] : 'unknown';

            return { mods: [{ id, version }], bundled: [] };
        } catch (err) {
            log(`Forge metadata error: ${err.message}`, 'var(--danger)');
            return { mods: [{ id: 'parse_error', version: 'unknown' }], bundled: [] };
        }
    }
}

class ConflictResolver {
    constructor(extractor) {
        this.extractor = extractor;
        this.modRegistry = new Map();
    }

    async analyzeFiles(files, packs) {
        this.modRegistry.clear();
        const enriched = [];

        const filesToAnalyze = files.filter(f => f.enabled && f.downloads && f.downloads.length > 0);
        const skippedFiles = files.filter(f => !f.enabled || !f.downloads || f.downloads.length === 0);

        skippedFiles.forEach(file => {
            enriched.push({ ...file, metadata: null, conflicts: [] });
        });

        const batchSize = 5;
        const totalFiles = filesToAnalyze.length;

        for (let i = 0; i < totalFiles; i += batchSize) {
            const batch = filesToAnalyze.slice(i, i + batchSize);
            const progress = Math.min(i + batchSize, totalFiles);

            log(`Analyzing JARs: ${progress}/${totalFiles}`, 'var(--accent)');

            const batchResults = await Promise.all(
                batch.map(async (file) => {
                    const pack = packs.find(p => p.id === file.pId);
                    const url = file.downloads[0];
                    const metadata = await this.extractor.extract(url, file.fileName);
                    const conflicts = this.detectConflicts(file, metadata, pack);
                    return { ...file, metadata, conflicts };
                })
            );

            batchResults.forEach(result => {
                enriched.push(result);
                this.registerMods(result, result.metadata);
            });
        }

        return enriched;
    }

    detectConflicts(file, metadata, pack) {
        const conflicts = [];
        if (!metadata || !metadata.mods) return conflicts;

        for (const mod of metadata.mods) {
            if (this.modRegistry.has(mod.id)) {
                const existing = this.modRegistry.get(mod.id);
                const comparison = VersionComparator.compare(mod.version, existing.version);

                if (comparison !== 0) {
                    conflicts.push({
                        type: 'version',
                        modId: mod.id,
                        thisVersion: mod.version,
                        otherVersion: existing.version,
                        otherFile: existing.fileName,
                        resolution: comparison > 0 ? 'keep_this' : 'keep_other'
                    });
                } else {
                    conflicts.push({
                        type: 'duplicate',
                        modId: mod.id,
                        version: mod.version,
                        otherFile: existing.fileName
                    });
                }
            }
        }
        return conflicts;
    }

    registerMods(file, metadata) {
        if (!metadata || !metadata.mods) return;
        for (const mod of metadata.mods) {
            if (!this.modRegistry.has(mod.id)) {
                this.modRegistry.set(mod.id, {
                    fileName: file.fileName,
                    version: mod.version,
                    packId: file.pId
                });
            }
        }
    }

    extractModSlug(filename) {
        if (!filename.toLowerCase().endsWith('.jar')) return filename;
        let name = filename.slice(0, -4);
        const match = name.match(/^(.*?)(?:[-+](?:\d|v\d))/i);
        if (match) {
            name = match[1];
        }
        return name.toLowerCase().trim();
    }

    resolveByPriority(files, packs) {
        const pathRegistry = new Map();
        const modIdRegistry = new Map();
        const slugRegistry = new Map();

        for (const pack of packs) {
            const packFiles = files.filter(f => f.pId === pack.id);

            for (const file of packFiles) {
                file.isDuplicate = false;
                file.enabled = true;

                if (pathRegistry.has(file.path)) {
                    file.enabled = false;
                    file.isDuplicate = true;
                    file.keptSource = pathRegistry.get(file.path);
                    file.conflictReason = 'Exact path duplicate';
                    continue;
                }
                pathRegistry.set(file.path, file.pName || pack.name);

                if (file.metadata && file.metadata.mods) {
                    let isOlder = false;
                    for (const mod of file.metadata.mods) {
                        if (modIdRegistry.has(mod.id)) {
                            const existing = modIdRegistry.get(mod.id);
                            const comparison = VersionComparator.compare(mod.version, existing.version);
                            if (comparison < 0) {
                                isOlder = true;
                                file.keptSource = existing.packName;
                                file.conflictReason = `Older version (Mod ID: ${mod.id})`;
                                break;
                            }
                        }
                    }

                    if (isOlder) {
                        file.enabled = false;
                        file.isDuplicate = true;
                        continue;
                    }

                    for (const mod of file.metadata.mods) {
                        modIdRegistry.set(mod.id, {
                            version: mod.version,
                            packName: file.pName || pack.name
                        });
                    }
                }

                if (file.category === 'mods') {
                    const slug = this.extractModSlug(file.fileName);
                    if (slugRegistry.has(slug)) {
                        const existing = slugRegistry.get(slug);
                        file.enabled = false;
                        file.isDuplicate = true;
                        file.keptSource = existing.packName;
                        file.conflictReason = `Possible duplicate of ${existing.fileName}`;
                        continue;
                    }
                    slugRegistry.set(slug, {
                        fileName: file.fileName,
                        packName: file.pName || pack.name
                    });
                }
            }
        }
    }
}

class CompatibilityValidator {
    static checkPackCompatibility(packs) {
        const issues = [];
        if (packs.length === 0) return issues;

        const basePack = packs[0];
        const baseVersion = basePack.ver;
        const baseLoader = basePack.loader;

        for (let i = 1; i < packs.length; i++) {
            const pack = packs[i];
            if (pack.ver !== baseVersion) {
                issues.push({
                    type: 'version_mismatch',
                    severity: 'critical',
                    pack1: basePack.name,
                    pack2: pack.name,
                    version1: baseVersion,
                    version2: pack.ver,
                    message: `Minecraft version mismatch: ${basePack.name} (${baseVersion}) vs ${pack.name} (${pack.ver})`
                });
            }
            if (pack.loader !== baseLoader) {
                issues.push({
                    type: 'loader_mismatch',
                    severity: 'critical',
                    pack1: basePack.name,
                    pack2: pack.name,
                    loader1: baseLoader,
                    loader2: pack.loader,
                    message: `Mod loader mismatch: ${basePack.name} (${baseLoader}) vs ${pack.name} (${pack.loader})`
                });
            }
        }
        return issues;
    }

    static getCompatibilitySummary(issues) {
        if (issues.length === 0) return { compatible: true, message: 'All packs are compatible' };
        const versionIssues = issues.filter(i => i.type === 'version_mismatch').length;
        const loaderIssues = issues.filter(i => i.type === 'loader_mismatch').length;
        const messages = [];
        if (versionIssues > 0) messages.push(`${versionIssues} version conflict(s)`);
        if (loaderIssues > 0) messages.push(`${loaderIssues} loader conflict(s)`);
        return { compatible: false, message: messages.join(', '), details: issues };
    }
}

class StandardPackResolver {
    static getCategory(path) {
        const lowerPath = path.toLowerCase();
        if (lowerPath.startsWith('mods/') || lowerPath.includes('/mods/')) return 'mods';
        if (lowerPath.startsWith('resourcepacks/') || lowerPath.includes('resourcepacks/')) return 'resourcepacks';
        if (lowerPath.startsWith('shaderpacks/') || lowerPath.includes('shaderpacks/')) return 'shaderpacks';
        if (lowerPath.startsWith('config/') || lowerPath.includes('config/')) return 'configs';
        if (lowerPath.startsWith('scripts/') || lowerPath.includes('scripts/')) return 'scripts';
        return 'others';
    }

    static async detectMetadata(zip) {
        let version = null;
        let loader = null;

        // 1. Check CurseForge manifest.json
        const manifestEntry = zip.file('manifest.json');
        if (manifestEntry) {
            try {
                const data = JSON.parse(await manifestEntry.async('string'));
                if (data.minecraft) {
                    version = data.minecraft.version;
                    if (data.minecraft.modLoaders && data.minecraft.modLoaders.length > 0) {
                        loader = data.minecraft.modLoaders[0].id.split('-')[0]; // "fabric-0.14.22" -> "fabric"
                    }
                }
            } catch (e) {
                console.warn('Failed to parse manifest.json');
            }
        }

        // 2. Check MultiMC / Prism instance.cfg
        const instanceCfg = zip.file('instance.cfg');
        if (instanceCfg && !version) {
            try {
                const content = await instanceCfg.async('string');
                const vMatch = content.match(/IntendedVersion=([^ \r\n]+)/);
                if (vMatch) version = vMatch[1];
                if (content.includes('LWJGL')) loader = content.includes('Fabric') ? 'fabric' : 'forge';
            } catch (e) { }
        }

        // 3. Heuristics on mod filenames
        if (!version || !loader) {
            const modPaths = Object.keys(zip.files).filter(p => (p.startsWith('mods/') || p.includes('/mods/')) && p.endsWith('.jar'));
            for (const path of modPaths) {
                const name = path.split('/').pop();
                if (!version) {
                    const vMatch = name.match(/(1\.\d+(?:\.\d+)?)/); // e.g. 1.20.1
                    if (vMatch) version = vMatch[1];
                }
                if (!loader) {
                    if (name.toLowerCase().includes('fabric')) loader = 'fabric';
                    else if (name.toLowerCase().includes('forge')) loader = 'forge';
                    else if (name.toLowerCase().includes('quilt')) loader = 'quilt';
                    else if (name.toLowerCase().includes('neoforge')) loader = 'neoforge';
                }
                if (version && loader) break;
            }
        }

        return {
            ver: version || (loadedPacks.length > 0 ? loadedPacks[0].ver : null),
            loader: loader || (loadedPacks.length > 0 && loadedPacks[0].loader !== 'unknown' ? loadedPacks[0].loader : null)
        };
    }

    static async resolve(zip, pId, pName) {
        const files = [];
        const entries = Object.keys(zip.files);
        for (const path of entries) {
            const entry = zip.files[path];
            if (entry.dir) continue;

            files.push({
                path: path,
                fileName: path.split('/').pop(),
                pId, pName,
                enabled: true,
                category: this.getCategory(path),
                isStandard: true,
                _entry: entry
            });
        }
        return files;
    }
}

let loadedPacks = [];
let allFiles = [];
let currentTab = 'mods';
let metadataExtractor = new JarMetadataExtractor();
let conflictResolver = new ConflictResolver(metadataExtractor);
let analysisInProgress = false;

initCounter();

function log(msg, color = 'var(--success)', bold = false) {
    const area = document.getElementById('log-area');
    const entry = document.createElement('div');
    entry.style.color = color;
    if (bold) entry.style.fontWeight = 'bold';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    area.appendChild(entry);
    area.scrollTop = area.scrollHeight;
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
        try {
            const zip = await JSZip.loadAsync(file);
            const indexFile = zip.file("modrinth.index.json");
            const pId = Math.random().toString(36).substr(2, 9);
            deepAnalysisPerformed = false;

            if (indexFile) {
                const index = JSON.parse(await indexFile.async("string"));
                if (loadedPacks.some(p => p.name === index.name)) {
                    log(`Skipped: Modrinth Pack "${index.name}" is already loaded.`, 'var(--warning)');
                    continue;
                }

                const packFiles = index.files.map(f => ({
                    path: f.path,
                    fileName: f.path.split('/').pop(),
                    pId, pName: index.name,
                    enabled: true,
                    category: 'mods', // Remote Modrinth files are always jars
                    isStandard: false,
                    downloads: f.downloads,
                    _original: f
                }));

                for (let path in zip.files) {
                    if (path.startsWith("overrides/") && !zip.files[path].dir) {
                        const relPath = path.replace("overrides/", "");
                        packFiles.push({
                            path: relPath,
                            fileName: relPath.split('/').pop(),
                            pId, pName: index.name,
                            enabled: true,
                            category: StandardPackResolver.getCategory(relPath),
                            isStandard: true,
                            _entry: zip.files[path]
                        });
                    }
                }

                const depKeys = Object.keys(index.dependencies);
                let detectedLoader = 'fabric'; // Default to fabric if unknown
                if (depKeys.some(k => k.includes('fabric'))) detectedLoader = 'fabric';
                else if (depKeys.some(k => k.includes('forge')) && !depKeys.some(k => k.includes('neoforge'))) detectedLoader = 'forge';
                else if (depKeys.some(k => k.includes('neoforge'))) detectedLoader = 'neoforge';
                else if (depKeys.some(k => k.includes('quilt'))) detectedLoader = 'quilt';

                loadedPacks.push({
                    id: pId, zip,
                    name: index.name,
                    ver: index.dependencies.minecraft,
                    loader: detectedLoader,
                    type: 'modrinth',
                    metadata: index
                });
                allFiles.push(...packFiles);
                log(`Loaded Modrinth Pack: ${index.name}`);
            } else {
                if (loadedPacks.some(p => p.name === file.name)) {
                    log(`Skipped: Standard ZIP "${file.name}" is already loaded.`, 'var(--warning)');
                    continue;
                }
                const packFiles = await StandardPackResolver.resolve(zip, pId, file.name);
                const detected = await StandardPackResolver.detectMetadata(zip);

                loadedPacks.push({
                    id: pId, zip,
                    name: file.name,
                    ver: detected.ver || '1.20.1',
                    loader: detected.loader || 'fabric',
                    type: 'standard'
                });
                allFiles.push(...packFiles);
                log(`Loaded Standard ZIP: ${file.name} (Detected: ${detected.ver || '1.20.1'}, ${detected.loader || 'fabric'})`);
            }
        } catch (err) {
            log(`Error parsing pack: ${err.message}`, 'var(--danger)');
        }
    }
    updateUI();
    await performAnalysis(false);
});

async function performAnalysis(deep = false) {
    if (analysisInProgress) return;
    if (!deep) {
        const compatIssues = CompatibilityValidator.checkPackCompatibility(loadedPacks);
        displayCompatibilityWarnings(compatIssues);
        if (compatIssues.length === 0) {
            conflictResolver.resolveByPriority(allFiles, loadedPacks);
            const duplicateCount = allFiles.filter(f => f.isDuplicate && !f.enabled).length;
            if (duplicateCount > 0) {
                log(`Instant Check: Auto-resolved ${duplicateCount} duplicate(s) based on filenames.`, 'var(--accent)');
            }
        }
        updateUI();
        return;
    }

    const compatIssues = CompatibilityValidator.checkPackCompatibility(loadedPacks);
    if (compatIssues.length > 0) {
        alert("Warning: Cannot perform Deep JAR Analysis while compatibility issues exist.");
        return;
    }

    conflictResolver.resolveByPriority(allFiles, loadedPacks);
    const modsToAnalyze = allFiles.filter(f => f.enabled && f.downloads && f.downloads.length > 0).length;

    if (modsToAnalyze > 0) {
        if (!confirm(`Analyze ${modsToAnalyze} JAR files? \nThis will download each mod and perform an analysis on it to resolve conflicts. \nThis will take some time....`)) return;
    }

    analysisInProgress = true;
    const analyzeBtn = document.getElementById('deepAnalyzeBtn');
    if (analyzeBtn) {
        analyzeBtn.disabled = true;
        analyzeBtn.innerText = "Analyzing...";
    }

    try {
        allFiles = await conflictResolver.analyzeFiles(allFiles, loadedPacks);
        conflictResolver.resolveByPriority(allFiles, loadedPacks);
        deepAnalysisPerformed = true;
        log('Deep Analysis Complete', 'var(--success)', true);
    } catch (err) {
        log(`Analysis error: ${err.message}`, 'var(--danger)');
    }
    analysisInProgress = false;
    updateUI();
}

function displayCompatibilityWarnings(issues) {
    const warningDiv = document.getElementById('compatibility-warning');
    const detailsDiv = document.getElementById('compatibility-details');
    const mergeBtn = document.getElementById('mergeBtn');

    if (issues.length === 0) {
        warningDiv.style.display = 'none';
        return;
    }

    warningDiv.style.display = 'block';
    detailsDiv.innerHTML = issues.map(issue => `<div>• ${issue.message}</div>`).join('');
    mergeBtn.disabled = true;
}

function updateUI() {
    const list = document.getElementById('packList');
    list.innerHTML = '';
    const compatIssues = CompatibilityValidator.checkPackCompatibility(loadedPacks);
    const hasIssues = compatIssues.length > 0;

    loadedPacks.forEach((p, idx) => {
        const li = document.createElement('li');
        li.className = 'pack-item';
        const isIncompatible = hasIssues && idx > 0 && (p.ver !== loadedPacks[0].ver || p.loader !== loadedPacks[0].loader);

        li.innerHTML = `
            <div style="display:flex; align-items:center;">
                <div class="priority-controls">
                    <button class="p-btn" onclick="movePriority(${idx}, -1)">UP</button>
                    <button class="p-btn" onclick="movePriority(${idx}, 1)">DOWN</button>
                </div>
                <div>
                    <div><b>${p.name}</b> ${isIncompatible ? '<span class="badge danger">INCOMPATIBLE</span>' : ''}</div>
                    <div class="pack-meta">
                        <span class="meta-tag action" onclick="filterByPack('${p.id}')">View contents</span>
                        <span class="meta-tag ${p.type === 'standard' ? 'editable' : ''}" 
                              onclick="${p.type === 'standard' ? `editMetadata('${p.id}', 'ver')` : ''}"
                              title="${p.type === 'standard' ? 'Click to edit version' : ''}">${p.ver}</span>
                        <span class="meta-tag ${p.type === 'standard' ? 'editable' : ''}" 
                              onclick="${p.type === 'standard' ? `editMetadata('${p.id}', 'loader')` : ''}"
                              title="${p.type === 'standard' ? 'Click to edit loader' : ''}">${p.loader}</span>
                    </div>
                </div>
            </div>
            <button class="btn danger" onclick="removePack(${idx})">X</button>`;
        list.appendChild(li);
    });

    const mergeBtn = document.getElementById('mergeBtn');
    mergeBtn.disabled = (loadedPacks.length === 0 || hasIssues);

    const analyzeBtn = document.getElementById('deepAnalyzeBtn');
    if (analyzeBtn) {
        if (loadedPacks.length === 0) {
            analyzeBtn.disabled = true;
            analyzeBtn.title = 'Load packs first';
        } else if (hasIssues) {
            analyzeBtn.disabled = true;
            analyzeBtn.title = 'Fix compatibility issues first';
        } else if (analysisInProgress) {
            analyzeBtn.disabled = true;
            analyzeBtn.innerText = "Analyzing...";
        } else {
            analyzeBtn.disabled = false;
            analyzeBtn.title = '';
            analyzeBtn.innerText = 'Deep Analyze JARs';
        }
    }

    document.getElementById('status-text').textContent = `${loadedPacks.length} packs loaded.`;
    filterFiles();
}

function filterFiles() {
    const query = document.getElementById('modSearch').value.toLowerCase();
    const duplicatesOnly = document.getElementById('showDuplicatesOnly').checked;
    const grid = document.getElementById('modGrid');
    grid.innerHTML = '';

    const filtered = allFiles.filter(m => {
        if (m.category !== currentTab) return false;
        if (duplicatesOnly && !m.isDuplicate) return false;

        if (query.startsWith('pack:')) {
            const packId = query.substring(5);
            return m.pId === packId;
        }

        return m.fileName.toLowerCase().includes(query) || m.pName.toLowerCase().includes(query);
    });

    const visibleCount = document.getElementById('visibleCount');
    if (visibleCount) visibleCount.textContent = `${filtered.length} items shown`;

    filtered.forEach(m => {
        const card = document.createElement('div');
        card.className = `mod-card ${m.enabled ? '' : 'disabled'}`;

        let bundledInfo = '';
        if (m.metadata && m.metadata.bundled && m.metadata.bundled.length > 0) {
            bundledInfo = `<div style="font-size:0.65rem; color:var(--warning); margin-top:3px;">Contains ${m.metadata.bundled.length} bundled mod(s)</div>`;
        }

        let conflictInfo = '';
        if (m.conflictReason) {
            conflictInfo = `<span class="auto-resolved">Excluded: ${m.conflictReason}</span>`;
        } else if (m.isDuplicate && m.keptSource) {
            conflictInfo = `<span class="auto-resolved">Excluded: Replaced by ${m.keptSource}</span>`;
        }

        card.innerHTML = `
                ${m.isDuplicate ? '<span class="duplicate-badge">LOWER PRIO</span>' : ''}
                <input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="toggleFile('${m.path}','${m.pId}')">
                <div class="card-content">
                    <div class="file-title" title="${m.fileName}">${m.fileName}</div>
                    <div style="font-size:0.7rem; color:var(--accent)">Source: ${m.pName}</div>
                    ${bundledInfo}
                    ${conflictInfo}
                </div>`;
        grid.appendChild(card);
    });
}

function toggleFile(path, pId) {
    const file = allFiles.find(m => m.path === path && m.pId === pId);
    if (file) file.enabled = !file.enabled;
    filterFiles();
}

async function movePriority(idx, direction) {
    const newIdx = idx + direction;
    if (newIdx >= 0 && newIdx < loadedPacks.length) {
        const pack = loadedPacks.splice(idx, 1)[0];
        loadedPacks.splice(newIdx, 0, pack);
        deepAnalysisPerformed = false;
        await performAnalysis();
    }
}

async function mergePacks() {
    try {
        const isZipMode = deepAnalysisPerformed;
        log(`Starting export as ${isZipMode ? 'Standard ZIP' : 'MRPACK'}...`, 'var(--accent)', true);

        const outZip = new JSZip();
        const finalFiles = [];
        const finalFilePaths = new Set();
        const activeFiles = allFiles.filter(f => f.enabled);
        const total = activeFiles.length;
        let done = 0;

        const progressDiv = document.createElement('div');
        progressDiv.style.color = 'var(--accent)';
        progressDiv.style.fontFamily = 'monospace';
        document.getElementById('log-area').appendChild(progressDiv);

        const updateBar = (c) => {
            const p = Math.round((c / total) * 100);
            const bar = "#".repeat(Math.round(p / 4)) + "-".repeat(25 - Math.round(p / 4));
            progressDiv.textContent = `[${bar}] ${p}% (${c}/${total})`;
        };

        const transferList = [];
        const workerFiles = [];

        for (const pack of loadedPacks) {
            const packFiles = activeFiles.filter(f => f.pId === pack.id);
            for (const f of packFiles) {
                if (finalFilePaths.has(f.path)) { done++; updateBar(done); continue; }

                try {
                    let data;
                    if (isZipMode) {
                        if (f.isStandard) {
                            data = await f._entry.async("uint8array");
                        } else {
                            const cached = metadataExtractor.cache.get(f.downloads[0]);
                            if (cached && cached.blob) {
                                data = new Uint8Array(await cached.blob.arrayBuffer());
                            } else {
                                const resp = await fetch(f.downloads[0]);
                                data = new Uint8Array(await resp.arrayBuffer());
                            }
                        }
                    } else {
                        if (f.isStandard) {
                            data = await f._entry.async("uint8array");
                        } else {
                            finalFiles.push(f._original);
                        }
                    }

                    if (data) {
                        const path = isZipMode ? f.path : `overrides/${f.path}`;
                        workerFiles.push({ path, data });
                        transferList.push(data.buffer);
                    }
                    finalFilePaths.add(f.path);
                } catch (e) {
                    log(`Failed: ${f.fileName}`, 'var(--danger)');
                }
                done++;
                updateBar(done);
            }
        }

        let firstPackDeps = null;
        if (loadedPacks[0]) {
            const base = loadedPacks[0];
            if (base.type === 'modrinth' && base.metadata) {
                firstPackDeps = base.metadata.dependencies;
            } else {
                firstPackDeps = { minecraft: base.ver, [base.loader || 'fabric']: "latest" };
            }
        }

        const packName = document.getElementById('customPackName').value || "Merged Pack";
        const versionId = document.getElementById('customVersionId').value || "1.0.0";

        if (!isZipMode) {
            const index = {
                formatVersion: 1,
                game: 'minecraft',
                versionId: versionId,
                name: packName,
                files: finalFiles,
                dependencies: firstPackDeps || { minecraft: "1.20.1", fabric: "latest" }
            };
            const indexContent = new TextEncoder().encode(JSON.stringify(index, null, 2));
            workerFiles.push({ path: "modrinth.index.json", data: indexContent });
            transferList.push(indexContent.buffer);
        }

        log("Handing over to Background Worker...", "var(--accent)");
        progressDiv.textContent = "[Background] Initializing Worker...";

        const workerCode = `
            importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
            self.onmessage = async (e) => {
                const { files } = e.data;
                const zip = new JSZip();
                files.forEach(f => zip.file(f.path, f.data));
                
                const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (m) => {
                    self.postMessage({ type: 'progress', percent: m.percent });
                });
                self.postMessage({ type: 'complete', blob });
            };
        `;

        const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(workerBlob));

        worker.onmessage = (e) => {
            if (e.data.type === 'progress') {
                progressDiv.textContent = `Building ZIP: ${Math.round(e.data.percent)}%`;
            } else if (e.data.type === 'complete') {
                log("Export successful! Preparing download...", "var(--success)", true);
                saveAs(e.data.blob, `${packName}-${versionId}.${isZipMode ? 'zip' : 'mrpack'}`);
                worker.terminate();
            }
        };

        worker.postMessage({ files: workerFiles }, transferList);
    } catch (err) {
        log(`Fatal Error: ${err.message}`, 'var(--danger)');
        console.error(err);
    }
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.cat === tab));
    filterFiles();
}

function removePack(idx) {
    const id = loadedPacks[idx].id;
    allFiles = allFiles.filter(m => m.pId !== id);
    loadedPacks.splice(idx, 1);
    deepAnalysisPerformed = false;
    performAnalysis();
}

function filterByPack(id) {
    document.getElementById('modSearch').value = `pack:${id}`;
    filterFiles();
}

function bulkSet(val) {
    allFiles.filter(m => m.category === currentTab).forEach(f => f.enabled = val);
    filterFiles();
}

function editMetadata(pId, field) {
    const pack = loadedPacks.find(p => p.id === pId);
    if (!pack) return;
    const newVal = prompt(`Edit ${field}:`, pack[field]);
    if (newVal) { pack[field] = newVal; performAnalysis(); }
}

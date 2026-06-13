// ==========================================
// 1. SUPABASE DIRECT MOBILE CONNECTION
// ==========================================
// Replace these with your actual Supabase keys from your dashboard
const SUPABASE_URL = 'https://rdquiazrxmprmjsxlqom.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkcXVpYXpyeG1wcm1qc3hscW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NDQ2OTMsImV4cCI6MjA5NDIyMDY5M30.kn8qVA7qmwJxap6m2scd4PgyXoaD3eKAZF8XBQ-W2ts';
const SPOTIFY_CLIENT_ID = '059c5b9b66164856b74f30bff474b505'; // Found in Spotify Dev Dashboard
const REDIRECT_URI = 'https://speckify-mobile.pages.dev/'; // Automatically grabs your Live Server URL

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Global State
let localVaultCache = [];
let currentSearchArray = [];
let currentPage = 1;
const itemsPerPage = 100;
let latestData = { isLoggedIn: false, isPlaying: false };
let currentSpotifyTrackId = null;
let currentTrackTitle = "";
let currentTrackArtist = "";
let editingStandaloneId = null;
let pendingMatchId = null;

// ==========================================
// 2. SPOTIFY PKCE AUTHENTICATION
// ==========================================
const generateRandomString = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
};

const generateCodeChallenge = async (codeVerifier) => {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function loginToSpotify() {
    const codeVerifier = generateRandomString(128);
    localStorage.setItem('spotify_code_verifier', codeVerifier);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const scope = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
    const authUrl = new URL("https://accounts.spotify.com/authorize");

    const args = new URLSearchParams({
        response_type: 'code',
        client_id: SPOTIFY_CLIENT_ID,
        scope: scope,
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge
    });

    window.location = authUrl + '?' + args;
}

async function exchangeToken(code) {
    const codeVerifier = localStorage.getItem('spotify_code_verifier');
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: SPOTIFY_CLIENT_ID,
        code_verifier: codeVerifier
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
    });

    if (response.ok) {
        const data = await response.json();
        localStorage.setItem('spotify_access_token', data.access_token);
        localStorage.setItem('spotify_refresh_token', data.refresh_token);
        window.history.replaceState({}, document.title, REDIRECT_URI); // Clean URL
        latestData.isLoggedIn = true;
        bootApp();
    } else {
        console.error("Failed to exchange token");
    }
}

// ==========================================
// 3. DATABASE SYNC & VAULT LOGIC
// ==========================================
const escapeHtml = (text) => (text || "").toString().replace(/[&<"'>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

async function loadFullVault() {
    const countEl = document.getElementById('song-count');
    try {
        countEl.textContent = "Syncing...";
        let allData = [];
        let keepFetching = true;
        let from = 0;
        const pageSize = 1000;

        while (keepFetching) {
            const { data: pageData, error } = await supabaseClient.from('harmonic_vault').select('*').order('artist', { ascending: true }).range(from, from + pageSize - 1);
            if (error) throw error;
            if (pageData && pageData.length > 0) allData = allData.concat(pageData);
            if (!pageData || pageData.length < pageSize) keepFetching = false;
            else from += pageSize;
        }

        localVaultCache = allData;
        localStorage.setItem('speckify_vault', JSON.stringify(localVaultCache));
        countEl.textContent = localVaultCache.length;
        runLocalSearch();
    } catch (err) {
        const offlineData = localStorage.getItem('speckify_vault');
        if (offlineData) {
            localVaultCache = JSON.parse(offlineData);
            countEl.textContent = localVaultCache.length;
            runLocalSearch();
        }
    }
}

function matchLocal(spotifyId, rawTitle, artistArray) {
    if (!localVaultCache || localVaultCache.length === 0) return null;
    if (spotifyId) {
        let match = localVaultCache.find(row => row.spotify_id === spotifyId);
        if (match) return match;
    }
    if (!rawTitle) return null;

    const normalizeText = (str) => (str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&|\+/g, "and").replace(/[.,'?!]/g, "").trim();
    let cleanSpTitle = normalizeText(rawTitle.replace(/\s*\(.*?\)\s*/g, '').replace(/\s-.*$/, '').trim());

    return localVaultCache.find(row => {
        const dbTitle = normalizeText(row.title);
        const dbArtist = normalizeText(row.artist);
        const matchesTitle = dbTitle.includes(cleanSpTitle) || cleanSpTitle.includes(dbTitle);
        const matchesArtist = artistArray && artistArray.length > 0 ? artistArray.some(a => {
            let cleanSpArtist = normalizeText(a.name).replace(/^the\s+/, '').trim();
            let strippedDbArtist = dbArtist.replace(/^the\s+/, '').trim();
            if (strippedDbArtist.includes(cleanSpArtist) || cleanSpArtist.includes(strippedDbArtist)) return true;
            const words = cleanSpArtist.split(/\s+/).filter(w => w.length > 2);
            return words.some(word => strippedDbArtist.includes(word));
        }) : true;
        return matchesTitle && matchesArtist;
    });
}

// ==========================================
// 4. LIVE SPOTIFY POLLING (THE HEARTBEAT)
// ==========================================
async function fetchCurrentSong() {
    if (!latestData.isLoggedIn) return;
    const token = localStorage.getItem('spotify_access_token');

    try {
        const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.status === 204 || res.status > 400) {
            updateDashboardOffline(); // Nothing playing
            return;
        }

        const data = await res.json();
        if (!data || !data.item) return updateDashboardOffline();

        const track = data.item;
        currentSpotifyTrackId = track.id;
        currentTrackTitle = track.name.replace(/\s*\(.*?\)\s*/g, '').replace(/\s-.*$/, '').trim();
        currentTrackArtist = track.artists.map(a => a.name).join(', ');

        const match = matchLocal(track.id, currentTrackTitle, track.artists);
        const isExactMatch = match && match.spotify_id === track.id;

        latestData = {
            isLoggedIn: true,
            isPlaying: data.is_playing,
            title: currentTrackTitle,
            artist: currentTrackArtist,
            albumArt: track.album.images[0]?.url || "",
            spotifyId: track.id,
            matchFound: !!match,
            vaultId: match ? match.id : null,
            inherited: match ? match : null
        };

        // Render UI
        document.getElementById('song-title').innerText = latestData.title;
        document.getElementById('artist-name').innerText = latestData.artist;
        document.getElementById('track-art').src = latestData.albumArt;
        document.getElementById('guitar-key').innerText = match ? match.user_key || "--" : "--";
        document.getElementById('chords-display').innerText = match ? match.chords || "--" : "--";
        document.getElementById('notes-display').innerText = match ? match.notes || "--" : "--";
        document.getElementById('spotify-est-key').innerText = `Spotify Est: ${match ? match.spotify_camelot || '--' : '--'}`;

        // Traffic Light Logic
        const syncBtn = document.getElementById('sync-status-btn');
        const keyElement = document.getElementById('guitar-key');
        const editBtn = document.getElementById('edit-vault-btn');

        if (!match) {
            syncBtn.className = "sync-status-btn sync-status-red";
            syncBtn.innerText = "ADD NEW";
            syncBtn.onclick = () => openStandaloneEditModal(null);
            keyElement.classList.add('missing');
            editBtn.style.display = "none";
        } else {
            keyElement.classList.remove('missing');
            editBtn.style.display = "block";
            editBtn.onclick = () => openStandaloneEditModal(match.id);

            if (isExactMatch) {
                syncBtn.className = "sync-status-btn sync-status-green";
                syncBtn.innerText = "SYNCED";
                syncBtn.onclick = null;
            } else if (!match.spotify_id) {
                syncBtn.className = "sync-status-btn sync-status-yellow";
                syncBtn.innerText = "FIX MATCH";
                syncBtn.onclick = () => openSyncModal(latestData.title, latestData.artist);
            } else {
                syncBtn.className = "sync-status-btn";
                syncBtn.style.backgroundColor = "#d97706";
                syncBtn.innerText = "CLOSE MATCH (ADD NEW)";
                syncBtn.onclick = () => openStandaloneEditModal(null);
            }
        }

    } catch (err) {
        console.error("Spotify fetch error", err);
    }
}

function updateDashboardOffline() {
    document.getElementById('song-title').innerText = "Playback Paused";
    document.getElementById('artist-name').innerText = "Start playing on Spotify";
}

async function controlPlayback(action) {
    const token = localStorage.getItem('spotify_access_token');
    const method = (action === 'next' || action === 'previous') ? 'POST' : 'PUT';

    await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
        method: method,
        headers: { 'Authorization': `Bearer ${token}` }
    });
    setTimeout(fetchCurrentSong, 500); // Poll immediately after click
}

async function togglePlayPause() {
    const action = latestData.isPlaying ? 'pause' : 'play';
    await controlPlayback(action);
}

// ==========================================
// 5. DATABASE MODALS & WRITING
// ==========================================
function openStandaloneEditModal(vaultId) {
    editingStandaloneId = vaultId;
    document.getElementById('modal-title').innerText = vaultId ? "Edit Vault Entry" : "Add New Song";
    document.getElementById('edit-modal').style.display = 'flex';

    if (vaultId) {
        const song = localVaultCache.find(s => s.id === vaultId);
        if (song) {
            document.getElementById('edit-title').value = song.title || "";
            document.getElementById('edit-artist').value = song.artist || "";
            document.getElementById('edit-key').value = song.user_key || "";
            document.getElementById('edit-spotify-camelot').value = song.spotify_camelot || "";
            document.getElementById('edit-chords').value = song.chords || "";
            document.getElementById('edit-notes').value = song.notes || "";
        }
    } else {
        // Carry over current live data for New Songs / Close Matches
        document.getElementById('edit-title').value = currentTrackTitle || "";
        document.getElementById('edit-artist').value = currentTrackArtist || "";
        document.getElementById('edit-key').value = latestData.inherited ? latestData.inherited.user_key : "";
        document.getElementById('edit-spotify-camelot').value = latestData.inherited ? latestData.inherited.spotify_camelot : "";
        document.getElementById('edit-chords').value = latestData.inherited ? latestData.inherited.chords : "";
        document.getElementById('edit-notes').value = latestData.inherited ? latestData.inherited.notes : "";
    }
}

async function saveEdits() {
    const saveBtn = document.getElementById('save-edit-btn');
    saveBtn.innerText = "Saving...";
    saveBtn.disabled = true;

    const isNew = !editingStandaloneId;
    const songData = {
        title: document.getElementById('edit-title').value,
        artist: document.getElementById('edit-artist').value,
        user_key: document.getElementById('edit-key').value,
        spotify_camelot: document.getElementById('edit-spotify-camelot').value,
        chords: document.getElementById('edit-chords').value,
        notes: document.getElementById('edit-notes').value
    };

    if (isNew) songData.spotify_id = currentSpotifyTrackId;

    try {
        if (isNew) {
            const { data, error } = await supabaseClient.from('harmonic_vault').insert([songData]).select();
            if (error) throw error;
            if (data) localVaultCache.push(data[0]);
        } else {
            const { error } = await supabaseClient.from('harmonic_vault').update(songData).eq('id', editingStandaloneId);
            if (error) throw error;
            const index = localVaultCache.findIndex(s => s.id === editingStandaloneId);
            if (index !== -1) localVaultCache[index] = { ...localVaultCache[index], ...songData };
        }

        localStorage.setItem('speckify_vault', JSON.stringify(localVaultCache));
        runLocalSearch();
        fetchCurrentSong(); // Recalculate match!
        document.getElementById('edit-modal').style.display = 'none';
        document.getElementById('status-footer').innerText = isNew ? "✅ New song added!" : "✅ Vault updated!";
    } catch (err) {
        console.error("Failed to save:", err);
        document.getElementById('status-footer').innerText = "❌ Failed to save to cloud.";
    } finally {
        saveBtn.innerText = "Save Changes";
        saveBtn.disabled = false;
    }
}

function openSyncModal(title, artist) {
    document.getElementById('sync-modal').style.display = 'flex';
    document.getElementById('modal-match-details').innerText = `${title} by ${artist}`;
}
function closeSyncModal() { document.getElementById('sync-modal').style.display = 'none'; }

async function confirmMetadataSync() {
    if (!latestData.vaultId || !latestData.spotifyId) return;
    try {
        const { error } = await supabaseClient.from('harmonic_vault')
            .update({ spotify_id: latestData.spotifyId, title: latestData.title, artist: latestData.artist })
            .eq('id', latestData.vaultId);

        if (error) throw error;

        const index = localVaultCache.findIndex(s => s.id === latestData.vaultId);
        if (index !== -1) {
            localVaultCache[index].spotify_id = latestData.spotifyId;
            localVaultCache[index].title = latestData.title;
            localVaultCache[index].artist = latestData.artist;
            localStorage.setItem('speckify_vault', JSON.stringify(localVaultCache));
        }

        closeSyncModal();
        fetchCurrentSong(); // Recalculate match to trigger Green light
    } catch (err) {
        console.error("Sync Failed", err);
    }
}

// ==========================================
// 6. EXPLORER UI
// ==========================================
function runLocalSearch() {
    const searchInput = document.getElementById('vault-search');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : "";
    const sortType = document.getElementById('vault-sort').value;

    if (!searchTerm) {
        document.getElementById('explorer-results').innerHTML = '<p style="color: #888; text-align: center;">Type to search...</p>';
        document.getElementById('pagination-controls').style.display = 'none';
        currentSearchArray = []; return;
    }

    currentSearchArray = localVaultCache.filter(s => (s.title && s.title.toLowerCase().includes(searchTerm)) || (s.artist && s.artist.toLowerCase().includes(searchTerm)) || (s.user_key && s.user_key.toLowerCase().includes(searchTerm)) || (s.chords && s.chords.toLowerCase().includes(searchTerm)));
    currentSearchArray.sort((a, b) => ((a[sortType] || "").toLowerCase() < (b[sortType] || "").toLowerCase() ? -1 : 1));

    currentPage = 1;
    renderPage();
}

function renderPage() {
    const container = document.getElementById('explorer-results');
    const paginationBox = document.getElementById('pagination-controls');
    container.innerHTML = "";

    if (currentSearchArray.length === 0) {
        container.innerHTML = '<p style="color: #888; text-align: center;">No matches found.</p>';
        paginationBox.style.display = 'none'; return;
    }

    paginationBox.style.display = 'flex';
    const pageItems = currentSearchArray.slice((currentPage - 1) * itemsPerPage, ((currentPage - 1) * itemsPerPage) + itemsPerPage);

    pageItems.forEach(song => {
        const div = document.createElement('div');
        div.className = "search-result-item";
        div.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 15px 12px; border-bottom: 1px solid #333; cursor: pointer;";
        div.onclick = function () {
            document.querySelectorAll('.search-result-item').forEach(el => el.style.backgroundColor = 'transparent');
            this.style.backgroundColor = '#2a2a2a';
        };

        div.innerHTML = `
            <div style="flex: 1;">
                <strong style="font-size: 15px;">${escapeHtml(song.title) || "Unknown"}</strong> <br>
                <span style="font-size: 13px; color: #888;">${escapeHtml(song.artist) || "Unknown"}</span><br>
                <span style="font-size: 12px; color: var(--accent); font-weight: bold;">Key: ${escapeHtml(song.user_key) || "--"}</span>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
                <button onclick="event.stopPropagation(); openStandaloneEditModal('${song.id}')" style="background: #333; color: white; border: none; padding: 10px 15px; border-radius: 6px;">Edit</button>
            </div>
        `;
        container.appendChild(div);
    });

    const totalPages = Math.ceil(currentSearchArray.length / itemsPerPage);
    document.getElementById('page-indicator').innerText = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('prev-page-btn').disabled = (currentPage === 1);
    document.getElementById('next-page-btn').disabled = (currentPage === totalPages);
}

function changePage(direction) {
    const totalPages = Math.ceil(currentSearchArray.length / itemsPerPage);
    currentPage += direction;
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;
    renderPage();
    document.getElementById('explorer-results').scrollTop = 0;
}

// ==========================================
// 7. INITIALIZATION (BOOT)
// ==========================================
async function bootApp() {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('dashboard-view').style.display = 'block';
    document.getElementById('explorer-view').style.display = 'block';

    await loadFullVault();

    // Start Spotify Heartbeat Loop (Runs every 10 seconds)
    fetchCurrentSong();
    setInterval(fetchCurrentSong, 10000);
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Wire up the login button in HTML
    document.getElementById('spotify-login-btn').addEventListener('click', loginToSpotify);

    // 2. Check if we just returned from Spotify Auth
    const urlParams = new URLSearchParams(window.location.search);
    let code = urlParams.get('code');

    if (code) {
        await exchangeToken(code);
    } else if (localStorage.getItem('spotify_access_token')) {
        // Already logged in
        latestData.isLoggedIn = true;
        bootApp();
    } else {
        // Show Login Screen
        document.getElementById('login-view').style.display = 'block';
    }
});
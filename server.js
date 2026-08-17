const express = require('express');
const WebTorrent = require('webtorrent');

const app = express();
const client = new WebTorrent();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Keep track of torrents we've already started, keyed by magnet URI
const activeTorrents = new Map();

function torrentInfo(torrent) {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    progress: torrent.progress,
    numPeers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    files: torrent.files.map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length,
      likelyPlayable: /\.(mp4|webm|ogg|m4v)$/i.test(f.name)
    }))
  };
}

// Start (or fetch status of) a torrent from a magnet link
app.post('/api/add', (req, res) => {
  const { magnet } = req.body;
  if (!magnet || !magnet.startsWith('magnet:')) {
    return res.status(400).json({ error: 'Valid magnet link required' });
  }

  const existing = client.torrents.find(t => t.magnetURI === magnet);
  if (existing) {
    return res.json(torrentInfo(existing));
  }

  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      res.status(202).json({ status: 'pending', message: 'Still resolving metadata, poll /api/status' });
    }
  }, 15000);

  client.add(magnet, { path: '/tmp/webtorrent-streamer' }, (torrent) => {
    activeTorrents.set(torrent.infoHash, torrent);
    clearTimeout(timeout);
    if (!responded) {
      responded = true;
      res.json(torrentInfo(torrent));
    }
  });
});

// Poll current progress / peer count / file list
app.get('/api/status/:infoHash', (req, res) => {
  const torrent = client.get(req.params.infoHash);
  if (!torrent) return res.status(404).json({ error: 'Torrent not found — call /api/add first' });
  res.json(torrentInfo(torrent));
});

// The actual video stream endpoint — supports byte-range requests for seeking
app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const torrent = client.get(req.params.infoHash);
  if (!torrent) return res.status(404).send('Torrent not found — call /api/add first');

  const file = torrent.files[parseInt(req.params.fileIndex, 10)];
  if (!file) return res.status(404).send('File index out of range');

  const fileSize = file.length;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': guessMime(file.name),
      'Accept-Ranges': 'bytes'
    });
    file.createReadStream().pipe(res);
    return;
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': guessMime(file.name)
  });

  file.createReadStream({ start, end }).pipe(res);
});

function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mkv: 'video/x-matroska', // container plays in some Chromium builds only, not universal
    avi: 'video/x-msvideo',
    mov: 'video/quicktime'
  };
  return map[ext] || 'application/octet-stream';
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Torrent streamer running on port ${PORT}`);
});

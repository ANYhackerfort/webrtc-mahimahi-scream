import { CongestionGraph, BitrateGraph } from './congestion-graph.js';

const bitrateGraph = new BitrateGraph(document.getElementById('bitrateGraph'));
const congestionGraph = new CongestionGraph(document.getElementById('congestionGraph'));
const parameters = new URLSearchParams(location.search);
const role = parameters.get('role') === 'sender' ? 'sender' : 'receiver';
const otherRole = role === 'sender' ? 'receiver' : 'sender';
// Restrict candidates to this address so the media cannot bypass Mahimahi.
const iceAddress = parameters.get('iceAddress');

const ui = Object.fromEntries(
  ['title', 'video', 'start', 'stop', 'sent', 'received', 'status',
    'ceMarked', 'ceUnmarked', 'rtpLost', 'senderPackets',
    'senderRtt', 'receiverPackets', 'uplinkMarks', 'downlinkMarks',
    'uplinkDrops', 'downlinkDrops', 'uplinkQueue', 'downlinkQueue',
    'uplinkDelay', 'downlinkDelay', 'linkDelay', 'queueDepthLabel', 'queueDelayLabel', 'queueHint'].map(
    id => [id, document.getElementById(id)],
  ),
);
ui.title.textContent = role === 'sender'
  ? 'Sender · Y4M video'
  : 'Receiver · WebRTC video';


let peerConnection = null;
let localStream = null;
let statsTimer = null;
let starting = false;
let pendingCandidates = [];
const previousStats = new Map();
let latestPacketCounts = null;
let latestRates = { sent: 0, received: 0 };
let latestNetworkStats = null;

function packetCounts(reports) {
  const streams = [...reports.values()].filter(report => (
    report.type === 'inbound-rtp' && report.kind === 'video'
  ));
  if (!streams.length) return null;
  const total = key => streams.every(report => typeof report[key] === 'number')
    ? streams.reduce((sum, report) => sum + report[key], 0) : null;
  const received = total('packetsReceived');
  const ce = total('packetsReceivedWithCe');
  return {
    received,
    ceMarked: ce,
    notCeMarked: received !== null && ce !== null ? received - ce : null,
    lostEstimate: total('packetsLost'),
    reportedLost: total('packetsReportedAsLost'),
    reportedLostThenRecovered: total('packetsReportedAsLostButRecovered'),
  };
}

function displayCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function showPacketCounts(counts) {
  latestPacketCounts = counts;
}

function showExperimentStats(sample) {
  const sender = sample.sender;
  const receiver = sample.receiver;
  const network = sample.mahimahi;
  latestNetworkStats = network;
  ui.sent.textContent = `${Math.round(sender?.sentBytesPerSecond ?? 0).toLocaleString()} B/s`;
  ui.received.textContent = `${Math.round(receiver?.receivedBytesPerSecond ?? 0).toLocaleString()} B/s`;
  ui.senderPackets.textContent = displayCount(sender?.packetsSent);
  ui.senderRtt.textContent = sender?.roundTripTimeMs == null ? '—' : `${sender.roundTripTimeMs.toFixed(1)} ms`;
  ui.receiverPackets.textContent = displayCount(receiver?.packetsReceived);
  ui.ceMarked.textContent = displayCount(receiver?.ceMarkedPackets);
  ui.ceUnmarked.textContent = displayCount(receiver?.notCeMarkedPackets);
  ui.rtpLost.textContent = displayCount(receiver?.rtpPacketsLost);
  congestionGraph.update(receiver);
  bitrateGraph.update({ sender, receiver });
  const fifo = network?.configuration?.queue === 'droptail';
  ui.queueDepthLabel.textContent = fifo ? 'Outstanding packets' : 'Queued packets';
  ui.queueDelayLabel.textContent = fifo ? 'Last packet delay' : 'Queue wait';
  ui.queueHint.textContent = fifo
    ? 'FIFO: outstanding includes a packet in service; delay is the last delivered packet’s queueing + serialization time. No ECN marking. Fixed link delay is excluded.'
    : 'Queue wait is the oldest packet’s waiting time across the two DualPI2 subqueues, not an average. It excludes the configured link delay.';

  for (const direction of ['uplink', 'downlink']) {
    const queue = network?.queues?.find(queue => queue.direction === direction);
    ui[`${direction}Marks`].textContent = displayCount(queue?.ecn_mark);
    ui[`${direction}Drops`].textContent = displayCount(queue?.drop);
    ui[`${direction}Queue`].textContent = displayCount(fifo ? queue?.outstanding_pkts : queue?.q_pkts);
    const waits = [queue?.qdelay_l_ms, queue?.qdelay_c_ms];
    const delay = fifo ? queue?.last_sojourn_ms : waits.every(Number.isFinite) ? Math.max(...waits) : null;
    ui[`${direction}Delay`].textContent = Number.isFinite(delay) ? `${delay.toFixed(1)} ms` : '—';
  }
  const delay = network?.configuration?.delay_ms_each_way;
  const queueName = fifo ? 'FIFO (droptail)' : 'DualPI2';
  const limit = network?.configuration?.queue_packets;
  ui.linkDelay.textContent = delay == null ? 'Waiting for link statistics…'
    : `${queueName} · ${limit ?? 'default'}-packet limit · ${delay} ms delay each way`;
}

async function refreshStats() {
  try {
    const response = await fetch('/stats');
    if (!response.ok) throw new Error('Statistics unavailable');
    showExperimentStats(await response.json());
  } catch {
    // Keep the last sample visible during a brief signaling interruption.
  }
}
setInterval(refreshStats, 1000);
refreshStats();

function showStatus(message) {
  ui.status.textContent = message;
}

function showRates(sent, received) {
  latestRates = { sent, received };
  const element = role === 'sender' ? ui.sent : ui.received;
  const rate = role === 'sender' ? sent : received;
  element.textContent = `${Math.round(rate).toLocaleString()} B/s`;
}

// Signaling carries offers, answers, and ICE candidates; media uses WebRTC UDP.
async function sendSignal(message) {
  if (iceAddress && message.description) {
    message.description = {
      type: message.description.type,
      sdp: message.description.sdp.split('\r\n').filter(line => (
        !line.startsWith('a=candidate:') || line.split(' ')[4] === iceAddress
      )).join('\r\n'),
    };
  }
  const response = await fetch('/signal', {
    method: 'POST',
    body: JSON.stringify({ to: otherRole, ...message }),
  });
  if (!response.ok) throw new Error(await response.text());
}

function closeConnection() {
  clearInterval(statsTimer);
  peerConnection?.close();
  peerConnection = null;
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  ui.video.srcObject = null;
  previousStats.clear();
  pendingCandidates = [];
  showRates(0, 0);
  showPacketCounts(null);
  ui.start.disabled = false;
  ui.stop.disabled = true;
}

function handleError(error) {
  closeConnection();
  showStatus(error.message);
}

// Convert cumulative RTP payload counters into bytes/second over each sample.
async function updateRates(connection, finalSample = false) {
  const reports = await connection.getStats();
  if (connection !== peerConnection) return;
  let sent = 0;
  let received = 0;

  for (const report of reports.values()) {
    const outbound = report.type === 'outbound-rtp';
    const inbound = report.type === 'inbound-rtp';
    if ((!outbound && !inbound) || report.isRemote) continue;

    const bytes = outbound ? report.bytesSent : report.bytesReceived;
    const previous = previousStats.get(report.id);
    if (previous && report.timestamp > previous.timestamp) {
      const elapsedSeconds = (report.timestamp - previous.timestamp) / 1000;
      const bytesPerSecond = Math.max(0, (bytes - previous.bytes) / elapsedSeconds);
      if (outbound) sent += bytesPerSecond;
      else received += bytesPerSecond;
    }
    previousStats.set(report.id, { bytes, timestamp: report.timestamp });
  }
  showRates(sent, received);
  const counts = packetCounts(reports);
  showPacketCounts(counts);
  const videoReports = [...reports.values()].filter(report => report.kind === 'video');
  const outbound = videoReports.filter(report => report.type === 'outbound-rtp');
  const inbound = videoReports.filter(report => report.type === 'inbound-rtp');
  const remote = videoReports.find(report => report.type === 'remote-inbound-rtp');
  const sum = (streams, key) => streams.length && streams.every(report => typeof report[key] === 'number')
    ? streams.reduce((total, report) => total + report[key], 0) : null;
  const sample = {
    role, sessionId: connection.testSessionId, clientTimeMs: Date.now(),
    active: !finalSample,
    ...(role === 'sender' ? {
      sentBytesPerSecond: finalSample ? 0 : sent,
      bytesSent: sum(outbound, 'bytesSent'),
      packetsSent: sum(outbound, 'packetsSent'),
      retransmittedPackets: sum(outbound, 'retransmittedPacketsSent'),
      framesEncoded: sum(outbound, 'framesEncoded'),
      roundTripTimeMs: typeof remote?.roundTripTime === 'number' ? remote.roundTripTime * 1000 : null,
    } : {
      receivedBytesPerSecond: finalSample ? 0 : received,
      bytesReceived: sum(inbound, 'bytesReceived'),
      packetsReceived: counts?.received ?? null,
      ceMarkedPackets: counts?.ceMarked ?? null,
      notCeMarkedPackets: counts?.notCeMarked ?? null,
      rtpPacketsLost: counts?.lostEstimate ?? null,
      reportedLostPackets: counts?.reportedLost ?? null,
      recoveredPackets: counts?.reportedLostThenRecovered ?? null,
      framesDecoded: sum(inbound, 'framesDecoded'),
    }),
  };
  try {
    const response = await fetch('/telemetry', { method: 'POST', body: JSON.stringify(sample) });
    if (!response.ok) throw new Error('Could not save packet statistics');
  } catch (error) {
    showStatus(`Logging error: ${error.message}`);
  }
}

function createConnection() {
  const connection = new RTCPeerConnection({ iceServers: [] });
  connection.testSessionId = crypto.randomUUID();
  peerConnection = connection;

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    if (iceAddress && candidate.address !== iceAddress) return;
    sendSignal({ candidate }).catch(handleError);
  };
  connection.ontrack = event => {
    ui.video.srcObject = event.streams[0] || new MediaStream([event.track]);
  };
  connection.onconnectionstatechange = () => {
    if (connection === peerConnection) showStatus(connection.connectionState);
  };
  statsTimer = setInterval(() => {
    updateRates(connection).catch(error => {
      if (connection === peerConnection) handleError(error);
    });
  }, 1000);

  ui.stop.disabled = false;
  ui.start.disabled = true;
  return connection;
}

async function startSender() {
  closeConnection();
  const connection = createConnection();
  // Chromium's launch flag replaces the camera with the looping Y4M file.
  const capturedStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 360, frameRate: 30 },
    audio: false,
  });
  if (connection !== peerConnection) {
    capturedStream.getTracks().forEach(track => track.stop());
    return;
  }
  localStream = capturedStream;
  ui.video.srcObject = localStream;
  for (const track of localStream.getTracks()) {
    connection.addTransceiver(track, { direction: 'sendonly', streams: [localStream] });
  }
  await connection.setLocalDescription(await connection.createOffer());
  await sendSignal({ description: connection.localDescription });
}

async function startVideo() {
  if (starting || peerConnection) return;
  starting = true;
  try {
    if (role === 'sender') {
      await startSender();
    } else {
      ui.start.disabled = true;
      showStatus('Starting…');
      await sendSignal({ command: 'start' });
    }
  } catch (error) {
    handleError(error);
  } finally {
    starting = false;
  }
}

async function receiveDescription(description) {
  if (description.type === 'offer') {
    closeConnection();
    createConnection();
  }
  await peerConnection.setRemoteDescription(description);
  for (const candidate of pendingCandidates) {
    await peerConnection.addIceCandidate(candidate);
  }
  pendingCandidates = [];

  if (description.type === 'offer') {
    await peerConnection.setLocalDescription(await peerConnection.createAnswer());
    await sendSignal({ description: peerConnection.localDescription });
  }
}

async function receiveSignal(message) {
  if (message.command === 'stop') {
    if (peerConnection) await updateRates(peerConnection, true);
    closeConnection();
    showStatus('Stopped');
  } else if (message.command === 'start' && role === 'sender') {
    await startVideo();
  } else if (message.description) {
    await receiveDescription(message.description);
  } else if (message.candidate) {
    if (peerConnection?.remoteDescription) {
      await peerConnection.addIceCandidate(message.candidate);
    } else {
      pendingCandidates.push(message.candidate);
    }
  }
}

const events = new EventSource(`/events?role=${role}`);
events.onopen = () => {
  if (!peerConnection) {
    showStatus('Ready');
    ui.start.disabled = false;
  }
};
events.onerror = () => {
  showStatus('Signaling disconnected');
  ui.start.disabled = true;
};
// Preserve message order while asynchronous offer/answer processing finishes.
let signalQueue = Promise.resolve();
events.onmessage = event => {
  signalQueue = signalQueue
    .then(() => receiveSignal(JSON.parse(event.data)))
    .catch(handleError);
};

ui.start.onclick = startVideo;
ui.stop.onclick = async () => {
  if (peerConnection) await updateRates(peerConnection, true);
  closeConnection();
  showStatus('Stopped');
  try {
    await sendSignal({ command: 'stop' });
  } catch (error) {
    showStatus(error.message);
  }
};

// Browser-console diagnostics used to verify media and the selected network path.
window.testState = async () => {
  const stats = peerConnection ? await peerConnection.getStats() : new Map();
  const transport = [...stats.values()].find(
    report => report.type === 'transport' && report.selectedCandidatePairId,
  );
  const pair = transport && stats.get(transport.selectedCandidatePairId);
  return {
    role,
    state: peerConnection?.connectionState,
    sdp: peerConnection?.localDescription?.sdp,
    path: pair ? {
      local: stats.get(pair.localCandidateId),
      remote: stats.get(pair.remoteCandidateId),
    } : null,
    frames: ui.video.getVideoPlaybackQuality().totalVideoFrames,
    sent: `${Math.round(latestRates.sent).toLocaleString()} B/s`,
    received: `${Math.round(latestRates.received).toLocaleString()} B/s`,
    receivedPackets: latestPacketCounts,
    queueDrops: latestNetworkStats?.dropped_packets?.toString(),
    queueMarks: latestNetworkStats?.ecn_mark_operations?.toString(),
    bitrateGraph: {
      sent: bitrateGraph.history.lines.sent,
      received: bitrateGraph.history.lines.received,
      active: bitrateGraph.history.active,
    },
    congestionGraph: {
      samples: congestionGraph.history.points.length,
      latest: congestionGraph.history.points.at(-1),
      active: congestionGraph.history.active,
    },
  };
};

/* global fetch */

const $ = (id) => document.getElementById(id);
const agentLabels = { strategy: 'Estratégia', scriptWriter: 'Roteiro', thumbnailDesigner: 'Miniatura', seoOptimizer: 'SEO', production: 'Produção', publishing: 'Publicação', analytics: 'Análise' };
const viewTitles = {
  overview: ['Workspace', 'Visão geral'],
  contents: ['Biblioteca', 'Conteúdos'],
  create: ['Produção', 'Criar conteúdo'],
  schedule: ['Planejamento', 'Agenda'],
  connections: ['Sistema', 'Conexões'],
  reports: ['Desempenho', 'Relatórios'],
  settings: ['Sistema', 'Configurações'],
  detail: ['Biblioteca', 'Assistir conteúdo']
};
const statusLabels = { queued: 'Na fila', processing: 'Em produção', ready: 'Pronto', scheduled: 'Agendado', published: 'Publicado', simulated: 'Precisa de atenção', failed: 'Falhou', replaced: 'Substituído' };
let contentItems = [];
let selectedContentId = null;
let reviewSuggestions = null;
let productionJobs = [];
const initialContentId = window.location.pathname.match(/^\/conteudos\/([^/]+)$/)?.[1] || null;
let initialContentOpened = false;

function text(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function formatDate(value) {
  if (!value) return 'Sem data';
  const date = new Date(value.endsWith?.('Z') || value.includes?.('+') ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? 'Sem data' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '');
}

function formatUptime(seconds = 0) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} h ${minutes} min`;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Sessão expirada');
  }
  return response;
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-scrim').hidden = true;
  $('menu-button').setAttribute('aria-expanded', 'false');
}

function showView(name, updateHash = true) {
  const view = viewTitles[name] ? name : 'overview';
  document.querySelectorAll('.app-view').forEach((section) => section.classList.toggle('active', section.dataset.view === view));
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    const active = link.dataset.viewLink === view;
    if (link.classList.contains('nav-item')) link.classList.toggle('active', active);
    if (active && link.classList.contains('nav-item')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('page-kicker').textContent = viewTitles[view][0];
  $('page-title').textContent = viewTitles[view][1];
  if (updateHash) window.history.replaceState(null, '', view === 'detail' && selectedContentId ? `/conteudos/${encodeURIComponent(selectedContentId)}` : `/#${view}`);
  closeSidebar();
  $('main-content').focus({ preventScroll: true });
}

function updateHealth(data) {
  const healthy = data.status === 'healthy' && data.initialized;
  $('system-status').textContent = healthy ? 'Sistema ativo' : 'Inicializando';
  $('agent-count').textContent = `${data.agents?.length || 0} de 7`;
  $('last-updated').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  $('uptime').textContent = formatUptime(data.uptime);
  $('agent-status').innerHTML = (data.agents || []).map((agent) => `<div class="agent"><i aria-hidden="true"></i><span>${text(agentLabels[agent] || agent)}</span></div>`).join('');
}

function scheduleMarkup(schedule) {
  if (!schedule.length) {
    return '<div class="list-item"><div><strong>Geração diária</strong><br><small>Preparação automática de conteúdo</small></div><strong>06:00</strong></div><div class="list-item"><div><strong>Análise do canal</strong><br><small>Leitura de desempenho</small></div><strong>09:00</strong></div>';
  }
  return schedule.map((item) => {
    const date = new Date(item.publishTime || item.scheduledTime);
    return `<div class="list-item"><div><strong>${text(item.title || 'Nova publicação')}</strong><br><small>${text(formatDate(date.toISOString()))}</small></div><strong>${text(date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))}</strong></div>`;
  }).join('');
}

function updateSchedule(items) {
  const schedule = Array.isArray(items) ? items : [];
  const markup = scheduleMarkup(schedule.slice(0, 5));
  $('upcoming-schedule').innerHTML = markup;
  $('full-schedule').innerHTML = scheduleMarkup(schedule);
  if (schedule.length) {
    const next = new Date(schedule[0].publishTime || schedule[0].scheduledTime);
    $('next-generation').textContent = next.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } else {
    $('next-generation').textContent = '06:00';
  }
}

function updateMetrics(data = {}) {
  const total = Math.max(data.totalVideos || 0, contentItems.length);
  $('content-count').textContent = total.toLocaleString('pt-BR');
  $('published-count').textContent = (data.publishedVideos ?? contentItems.filter((item) => item.status === 'published').length).toLocaleString('pt-BR');
}

function contentRow(item) {
  const status = statusLabels[item.status] || item.status || 'Em produção';
  return `<div class="content-row"><span class="content-thumb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 8 7 4-7 4z"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg></span><div class="content-main"><strong title="${text(item.title)}">${text(item.title)}</strong><small>${text(item.topic)} · ${text(formatDate(item.createdAt))}</small></div><span class="status-badge status-${text(item.status)}">${text(status)}</span></div>`;
}

function emptyState(hasFilter) {
  return `<div class="empty-state"><span class="empty-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="m10 9 5 3-5 3z"/></svg></span><h3>${hasFilter ? 'Nenhum resultado' : 'Nenhum conteúdo criado'}</h3><p>${hasFilter ? 'Tente outro termo ou selecione um status diferente.' : 'Quando você iniciar uma produção, ela aparecerá aqui com o status e a data.'}</p>${hasFilter ? '' : '<button class="primary-button" type="button" data-empty-create><span>Criar primeiro conteúdo</span></button>'}</div>`;
}

function renderContents() {
  const query = $('content-search').value.trim().toLocaleLowerCase('pt-BR');
  const status = $('status-filter').value;
  const filtered = contentItems.filter((item) => {
    const matchesText = !query || `${item.title} ${item.topic}`.toLocaleLowerCase('pt-BR').includes(query);
    return matchesText && (status === 'all' || item.status === status);
  });
  $('result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'item' : 'itens'}`;
  $('content-library').innerHTML = filtered.length ? filtered.map((item) => {
    const statusText = statusLabels[item.status] || item.status || 'Em produção';
    const youtubeLink = item.youtubeUrl ? `<a class="external-link" href="${text(item.youtubeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${text(item.title)} no YouTube"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg></a>` : '';
    const retryButton = ['failed', 'simulated'].includes(item.status) ? `<button class="content-action" type="button" data-action="retry" aria-label="Tentar novamente ${text(item.title)}">Tentar novamente</button>` : '';
    return `<article class="library-card" data-content-id="${text(item.id)}" tabindex="0" role="button" aria-label="Abrir ${text(item.title)}"><span class="content-thumb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 8 7 4-7 4z"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg></span><div class="content-main"><strong title="${text(item.title)}">${text(item.title)}</strong><div class="library-meta"><span>${text(item.topic)}</span><span>${text(item.duration || 'Duração não informada')}</span><span>${text(formatDate(item.createdAt))}</span></div></div><div class="library-actions"><span class="status-badge status-${text(item.status)}">${text(statusText)}</span>${youtubeLink}${retryButton}<button class="content-action" type="button" data-action="edit" aria-label="Editar ${text(item.title)}">Editar</button><button class="content-action danger" type="button" data-action="delete" aria-label="Apagar ${text(item.title)}">Apagar</button></div></article>`;
  }).join('') : emptyState(Boolean(query || status !== 'all'));
  const emptyCreate = $('content-library').querySelector('[data-empty-create]');
  if (emptyCreate) emptyCreate.addEventListener('click', () => showView('create'));
  document.querySelectorAll('[data-content-id]').forEach((card) => {
    const open = (event) => {
      if (event.target.closest('a')) return;
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'edit') return beginContentEdit(card.dataset.contentId);
      if (action === 'delete') return confirmContentDelete(card.dataset.contentId);
      if (action === 'retry') return retryContent(card.dataset.contentId, event.target.closest('[data-action]'));
      openContent(card.dataset.contentId);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
  });
}

function openContent(id) {
  const item = contentItems.find((content) => content.id === id);
  if (!item) return;
  selectedContentId = id;
  $('detail-title').textContent = item.title;
  $('detail-status').textContent = statusLabels[item.status] || item.status;
  $('detail-meta').textContent = `${item.topic} · ${item.duration || 'Duração não informada'} · ${formatDate(item.createdAt)}`;
  if (['queued', 'processing'].includes(item.status)) renderProductionPlayer(item);
  else if (item.videoUrl && ['ready', 'scheduled', 'published'].includes(item.status)) renderCustomPlayer(item);
  else $('video-frame').innerHTML = `<div class="video-empty"><strong>${['failed', 'simulated'].includes(item.status) ? 'A produção não gerou um vídeo válido' : 'Vídeo ainda indisponível'}</strong><p>${['failed', 'simulated'].includes(item.status) ? 'Use Tentar novamente para reiniciar a produção com o roteiro salvo.' : 'Quando a montagem terminar, o player aparecerá aqui.'}</p></div>`;
  $('edit-content-form').hidden = true;
  $('retry-content-button').hidden = !['failed', 'simulated'].includes(item.status);
  $('retry-content-message').textContent = '';
  showView('detail');
  window.history.replaceState(null, '', `/conteudos/${encodeURIComponent(id)}`);
  loadProductionDetail(id);
}

function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function renderCustomPlayer(item) {
  $('video-frame').innerHTML = `<div class="custom-player"><video id="content-video" playsinline preload="metadata" src="${text(item.videoUrl)}"${item.thumbnailUrl ? ` poster="${text(item.thumbnailUrl)}"` : ''}></video><div class="player-controls"><button id="player-toggle" type="button" aria-label="Reproduzir"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 8-13 8z"/></svg></button><span id="player-time">0:00 / 0:00</span><input id="player-seek" type="range" min="0" max="1000" value="0" aria-label="Posição do vídeo"><button id="player-mute" type="button" aria-label="Silenciar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9z"/><path d="M17 9c1 1 1 5 0 6"/></svg></button><button id="player-fullscreen" type="button" aria-label="Tela cheia"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg></button></div></div>`;
  const video = $('content-video');
  const toggle = $('player-toggle');
  const seek = $('player-seek');
  const update = () => {
    seek.value = video.duration ? Math.round((video.currentTime / video.duration) * 1000) : 0;
    $('player-time').textContent = `${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)}`;
    toggle.setAttribute('aria-label', video.paused ? 'Reproduzir' : 'Pausar');
    toggle.classList.toggle('playing', !video.paused);
  };
  toggle.addEventListener('click', () => video.paused ? video.play() : video.pause());
  video.addEventListener('click', () => video.paused ? video.play() : video.pause());
  video.addEventListener('timeupdate', update);
  video.addEventListener('durationchange', update);
  video.addEventListener('play', update);
  video.addEventListener('pause', update);
  seek.addEventListener('input', () => { if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration; });
  $('player-mute').addEventListener('click', () => { video.muted = !video.muted; $('player-mute').classList.toggle('active', video.muted); });
  $('player-fullscreen').addEventListener('click', () => $('video-frame').requestFullscreen?.());
}

function renderProductionPlayer(item) {
  const job = productionJobs.find(entry => entry.result?.contentId === item.id || entry.result?.productionId === item.id || `prod_${entry.id}` === item.id || entry.result?.retryOf === item.id);
  const progress = Math.max(0, Math.min(100, Number(job?.progress) || 0));
  const stateMessage = job?.operational === 'working' ? job.message : job?.operational === 'queued' ? 'Aguardando um worker disponível' : job?.operational === 'unresponsive' ? 'O worker parou de responder. O sistema ainda não confirmou uma falha.' : job?.message || 'Aguardando confirmação do servidor';
  $('video-frame').innerHTML = `<div class="production-player state-${text(job?.operational || 'unconfirmed')}" role="status" aria-live="polite" aria-atomic="true"><div class="production-player-orbit" aria-hidden="true"></div><strong>${progress}%</strong><span>${text(stateMessage)}</span><div class="production-player-track"><i style="transform:scaleX(${progress / 100})"></i></div><small>${job?.operational === 'working' ? 'O worker está respondendo. O player será liberado após validar o MP4 no R2.' : 'O percentual só muda quando o servidor confirma uma nova etapa.'}</small></div>`;
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Sem horário' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderProductionDetail(data) {
  const job = data.job;
  const storage = data.storage || {};
  const operationalLabels = { working: 'Trabalhando agora', queued: 'Aguardando worker', retrying: 'Nova tentativa', unresponsive: 'Sem resposta', completed: 'Concluído', failed: 'Falhou', unconfirmed: 'Não confirmado' };
  $('detail-worker-status').textContent = operationalLabels[job?.operational] || 'Sem trabalho confirmado';
  $('detail-worker-status').dataset.state = job?.operational || 'unconfirmed';
  $('detail-worker-heartbeat').textContent = job?.heartbeatAt ? `Última resposta às ${formatLogTime(job.heartbeatAt)}` : 'O worker ainda não respondeu';
  $('detail-queue-status').textContent = job?.result?.queueMode === 'redis' ? 'Redis com BullMQ' : job ? 'Fila local' : 'Sem trabalho associado';
  $('detail-job-id').textContent = job?.id || 'Sem ID de trabalho';
  $('detail-storage-status').textContent = storage.connected ? storage.publicPlayback ? 'Conectado e reproduzível' : 'Conectado sem URL pública' : storage.configured ? 'Falha na conexão' : 'Não configurado';
  const objects = Array.isArray(storage.objects) ? storage.objects : [];
  const totalBytes = objects.reduce((sum, object) => sum + Number(object.size || 0), 0);
  $('detail-storage-objects').textContent = objects.length ? `${objects.length} ${objects.length === 1 ? 'objeto' : 'objetos'}, ${Math.max(1, Math.round(totalBytes / 1024)).toLocaleString('pt-BR')} KB confirmados` : storage.error ? `Erro: ${storage.error}` : 'Nenhum objeto confirmado para este ID';
  const events = Array.isArray(data.events) ? data.events : [];
  const visibleEvents = events.length ? events : job ? [{ id: 'current', level: job.stage === 'failed' ? 'error' : 'info', stage: job.stage, progress: job.progress, message: job.message, createdAt: job.updatedAt }] : [];
  $('detail-log-count').textContent = `${visibleEvents.length} ${visibleEvents.length === 1 ? 'registro' : 'registros'}`;
  $('detail-server-log').innerHTML = visibleEvents.length ? visibleEvents.slice().reverse().map((event) => {
    const objectKey = event.details?.objectKey ? `<small>Objeto: ${text(event.details.objectKey)}</small>` : '';
    const count = event.details?.completed && event.details?.total ? `<small>Item ${text(event.details.completed)} de ${text(event.details.total)}</small>` : '';
    return `<li class="server-log-entry level-${text(event.level || 'info')}"><time datetime="${text(event.createdAt)}">${text(formatLogTime(event.createdAt))}</time><span class="server-log-level">${text(event.level === 'error' ? 'Erro' : event.level === 'warning' ? 'Atenção' : 'Servidor')}</span><div><strong>${text(event.message)}</strong><p>${text(event.stage)} · ${text(event.progress)}%</p>${objectKey}${count}</div></li>`;
  }).join('') : '<li class="server-log-empty">Nenhum registro do servidor foi encontrado para este conteúdo.</li>';
  if (selectedContentId) {
    const item = contentItems.find((content) => content.id === selectedContentId);
    if (item && ['queued', 'processing'].includes(item.status)) renderProductionPlayer(item);
  }
}

async function loadProductionDetail(id = selectedContentId) {
  if (!id) return;
  try {
    const response = await request(`/contents/${encodeURIComponent(id)}/production`);
    if (!response.ok) throw new Error('Não foi possível consultar a produção.');
    renderProductionDetail(await response.json());
  } catch (error) {
    $('detail-worker-status').textContent = 'Consulta indisponível';
    $('detail-worker-heartbeat').textContent = error.message;
  }
}

async function retryContent(id = selectedContentId, sourceButton = null) {
  const button = sourceButton || $('retry-content-button');
  const message = $('retry-content-message');
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Adicionando à fila';
  message.className = 'form-message';
  message.textContent = 'Preparando uma nova tentativa com o roteiro salvo.';
  try {
    const response = await request(`/contents/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível tentar novamente.');
    message.className = 'form-message success';
    message.textContent = 'Nova tentativa registrada. Acompanhe as confirmações do servidor nesta página.';
    await loadDashboard();
    openContent(result.contentId || id);
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function beginContentEdit(id = selectedContentId) {
  const item = contentItems.find((content) => content.id === id);
  if (!item) return;
  if (selectedContentId !== id) openContent(id);
  selectedContentId = id;
  $('edit-content-title').value = item.title || '';
  $('edit-content-topic').value = item.topic || '';
  $('edit-content-message').textContent = '';
  $('edit-content-form').hidden = false;
  $('edit-content-title').focus();
}

function confirmContentDelete(id = selectedContentId) {
  const item = contentItems.find((content) => content.id === id);
  if (!item) return;
  selectedContentId = id;
  $('delete-content-description').textContent = `“${item.title}” e seus arquivos serão removidos do sistema. Se já estiver publicado no YouTube, a publicação continuará no canal.`;
  $('delete-content-message').textContent = '';
  $('delete-content-dialog').showModal();
}

function updateConnections(data) {
  const channel = data.youtube || {};
  const youtubeStatus = channel.connected ? `${Number(channel.subscribers || 0).toLocaleString('pt-BR')} inscritos · ${Number(channel.videos || 0).toLocaleString('pt-BR')} vídeos` : channel.authorized ? 'Conta Google autorizada, mas nenhum canal foi encontrado nessa conta' : 'Conecte uma conta oficial do Google';
  $('connections-grid').innerHTML = `<article class="metric-card connection-card"><span>Canal do YouTube</span><strong>${text(channel.title || (channel.authorized ? 'Google autorizado' : 'Não conectado'))}</strong><small>${youtubeStatus}</small><a class="primary-button connection-action" href="/auth/google"><span>${channel.authorized ? 'Escolher outra conta' : 'Conectar com Google'}</span></a></article><article class="metric-card"><span>Inteligência artificial</span><strong>${text(data.ai?.provider || 'Não conectada')}</strong><small>${data.ai?.connected ? 'Disponível para produção' : 'Configuração necessária'}</small></article><article class="metric-card"><span>Fila de produção</span><strong>${text(data.queue?.provider || 'Fila local')}</strong><small>${data.queue?.connected ? 'Retomada automática ativa' : 'Redis ainda não conectado'}</small></article><article class="metric-card"><span>Mídia dos vídeos</span><strong>${text(data.storage?.provider || 'Railway')}</strong><small>${text(data.storage?.bucket || 'Armazenamento local')}</small></article><article class="metric-card"><span>Banco de dados</span><strong>${text(data.database?.provider || 'Não conectado')}</strong><small>${data.database?.connected ? `Gerenciado pela ${text(data.database.managedBy)}` : 'Configuração necessária'}</small></article><article class="metric-card"><span>Arquivos internos</span><strong>Volume Railway</strong><small>Credenciais e arquivos temporários</small></article>`;
  $('reports-grid').innerHTML = `<article class="metric-card"><span>Inscritos</span><strong>${Number(channel.subscribers || 0).toLocaleString('pt-BR')}</strong><small>Canal conectado</small></article><article class="metric-card"><span>Visualizações</span><strong>${Number(channel.views || 0).toLocaleString('pt-BR')}</strong><small>Total do canal</small></article><article class="metric-card"><span>Vídeos</span><strong>${Number(channel.videos || 0).toLocaleString('pt-BR')}</strong><small>Publicados no canal</small></article>`;
}

function updateJobs(jobs) {
  productionJobs = Array.isArray(jobs) ? jobs : [];
  const latest = (jobs || [])[0];
  const active = (jobs || []).find((job) => !['completed', 'failed'].includes(job.stage));
  const overviewJob = active || latest;
  $('production-panel').hidden = !overviewJob;
  if (overviewJob) {
    $('production-stage').textContent = overviewJob.message;
    $('production-message').textContent = overviewJob.stage === 'failed'
      ? 'Essa produção foi interrompida e não está mais sendo processada. Abra Criar conteúdo para iniciar novamente.'
      : overviewJob.stage === 'completed' ? 'A produção foi concluída e está disponível em Conteúdos.' : `Etapa atual: ${overviewJob.stage}`;
    $('production-percent').textContent = `${overviewJob.progress}%`;
    $('production-progress').style.width = `${overviewJob.progress}%`;
  }

  let dock = $('global-production-status');
  if (!dock) {
    document.body.insertAdjacentHTML('beforeend', '<button id="global-production-status" class="production-dock" type="button" hidden><span class="production-dock-label">Produção</span><strong></strong><span class="production-dock-meta"></span><span class="production-dock-track"><i></i></span></button>');
    dock = $('global-production-status');
    dock.addEventListener('click', () => showView('overview'));
  }
  if (!latest) {
    dock.hidden = true;
    return;
  }
  const finishedRecently = latest.stage === 'completed' && Date.now() - new Date(latest.updatedAt).getTime() < 2 * 60 * 1000;
  dock.hidden = !active && !finishedRecently;
  const shown = active || latest;
  dock.classList.toggle('failed', shown.stage === 'failed');
  dock.classList.toggle('completed', shown.stage === 'completed');
  dock.querySelector('strong').textContent = shown.message;
  dock.querySelector('.production-dock-meta').textContent = `${shown.progress}% · ${shown.stage === 'completed' ? 'Concluído' : shown.stage === 'failed' ? 'Falhou' : 'Em andamento'}`;
  dock.querySelector('.production-dock-track i').style.width = `${shown.progress}%`;
  if (selectedContentId && document.querySelector('.app-view[data-view="detail"].active')) {
    const item = contentItems.find(content => content.id === selectedContentId);
    if (item && ['queued', 'processing'].includes(item.status)) renderProductionPlayer(item);
  }
}

async function loadJobs() {
  try {
    const response = await request('/production-status');
    if (response.ok) updateJobs(await response.json());
  } catch (_error) {
    // The full dashboard refresh handles connection state.
  }
}

function connectProductionEvents() {
  if (!window.EventSource) return;
  const source = new window.EventSource('/production-events');
  source.addEventListener('snapshot', (event) => {
    try { updateJobs(JSON.parse(event.data)); } catch (_error) { /* Polling remains available. */ }
  });
  source.addEventListener('production', (event) => {
    try {
      const job = JSON.parse(event.data);
      const jobs = [job, ...productionJobs.filter(item => item.id !== job.id)].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      updateJobs(jobs);
      if (selectedContentId && (job.result?.contentId === selectedContentId || job.result?.productionId === selectedContentId || job.result?.retryOf === selectedContentId || `prod_${job.id}` === selectedContentId)) loadProductionDetail(selectedContentId);
      if (['completed', 'failed'].includes(job.stage)) loadDashboard();
    } catch (_error) { /* Polling remains available. */ }
  });
}

function updateContents(items) {
  contentItems = Array.isArray(items) ? items : [];
  $('sidebar-content-count').textContent = contentItems.length;
  $('recent-contents').innerHTML = contentItems.length ? contentItems.slice(0, 6).map(contentRow).join('') : emptyState(false);
  const overviewCreate = $('recent-contents').querySelector('[data-empty-create]');
  if (overviewCreate) overviewCreate.addEventListener('click', () => showView('create'));
  renderContents();
}

async function loadDashboard() {
  try {
    const [healthResponse, scheduleResponse, analyticsResponse, contentsResponse, connectionsResponse, jobsResponse] = await Promise.all([request('/health'), request('/schedule'), request('/analytics'), request('/contents'), request('/connections'), request('/production-status')]);
    if (![healthResponse, scheduleResponse, analyticsResponse, contentsResponse].every((response) => response.ok)) throw new Error('Falha ao carregar os dados');
    updateHealth(await healthResponse.json());
    updateSchedule(await scheduleResponse.json());
    const analytics = await analyticsResponse.json();
    updateContents(await contentsResponse.json());
    if (initialContentId && !initialContentOpened) {
      initialContentOpened = true;
      openContent(decodeURIComponent(initialContentId));
    }
    updateMetrics(analytics);
    if (connectionsResponse.ok) updateConnections(await connectionsResponse.json());
    if (jobsResponse.ok) updateJobs(await jobsResponse.json());
  } catch (error) {
    if (error.message !== 'Sessão expirada') {
      $('system-status').textContent = 'Sem conexão';
      $('uptime').textContent = 'Tente atualizar';
    }
  }
}

document.querySelectorAll('[data-view-link]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView(link.dataset.viewLink); }));
$('menu-button').addEventListener('click', () => { $('sidebar').classList.add('open'); $('sidebar-scrim').hidden = false; $('menu-button').setAttribute('aria-expanded', 'true'); });
$('sidebar-close').addEventListener('click', closeSidebar);
$('sidebar-scrim').addEventListener('click', closeSidebar);
$('content-search').addEventListener('input', renderContents);
$('status-filter').addEventListener('change', renderContents);
$('refresh-button').addEventListener('click', loadDashboard);
$('logout-button').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.assign('/login'); });
$('edit-content-button').addEventListener('click', () => beginContentEdit());
$('retry-content-button').addEventListener('click', () => retryContent());
$('refresh-production-detail').addEventListener('click', () => loadProductionDetail());
$('delete-content-button').addEventListener('click', () => confirmContentDelete());
$('cancel-content-edit').addEventListener('click', () => { $('edit-content-form').hidden = true; });
$('edit-content-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await request(`/contents/${encodeURIComponent(selectedContentId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('edit-content-title').value.trim(), topic: $('edit-content-topic').value.trim() }) });
  const result = await response.json();
  if (!response.ok) {
    $('edit-content-message').className = 'form-message error';
    $('edit-content-message').textContent = result.error || 'Não foi possível salvar.';
    return;
  }
  $('edit-content-message').className = 'form-message success';
  $('edit-content-message').textContent = 'Alterações salvas.';
  await loadDashboard();
  openContent(selectedContentId);
});
$('confirm-delete-content').addEventListener('click', async (event) => {
  event.preventDefault();
  const button = $('confirm-delete-content');
  button.disabled = true;
  button.textContent = 'Apagando';
  try {
    const response = await request(`/contents/${encodeURIComponent(selectedContentId)}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível apagar o conteúdo.');
    $('delete-content-dialog').close();
    await loadDashboard();
    showView('contents');
  } catch (error) {
    $('delete-content-message').className = 'form-message error';
    $('delete-content-message').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Apagar conteúdo';
  }
});

const SCRIPT_LIMIT = 5500000;
function updateScriptCounter() {
  const script = $('script-input').value;
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const estimatedMinutes = words ? Math.max(1, Math.round(words / 140)) : 0;
  const targetMinutes = Math.max(1, Number($('target-minutes').value) || estimatedMinutes || 1);
  const scenes = Math.max(1, Number($('scene-count').value) || 1);
  $('script-counter').textContent = `${script.length.toLocaleString('pt-BR')} / ${SCRIPT_LIMIT.toLocaleString('pt-BR')}`;
  $('script-word-count').textContent = words.toLocaleString('pt-BR');
  $('script-duration').textContent = `${estimatedMinutes} min`;
  $('visual-rhythm').textContent = `${Math.round((targetMinutes * 60) / scenes)} s`;
}
$('script-input').addEventListener('input', updateScriptCounter);
$('target-minutes').addEventListener('input', updateScriptCounter);
$('scene-count').addEventListener('input', updateScriptCounter);
updateScriptCounter();
$('suggest-scenes-button').addEventListener('click', async () => {
  const button = $('suggest-scenes-button');
  const explanation = $('scene-suggestion');
  button.disabled = true;
  button.textContent = 'Analisando';
  explanation.textContent = 'Analisando duração, formato e ritmo do conteúdo.';
  try {
    const response = await request('/api/suggest-scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: $('script-input').value.trim(), targetMinutes: Number($('target-minutes').value), style: $('style').value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível sugerir a quantidade de cenas.');
    $('scene-count').value = result.sceneCount;
    explanation.textContent = result.reason;
    updateScriptCounter();
  } catch (error) {
    explanation.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Sugerir com IA';
  }
});
$('close-script-review').addEventListener('click', () => { $('script-review').hidden = true; });
$('apply-review-suggestions').addEventListener('click', () => {
  if (!reviewSuggestions) return;
  $('style').value = reviewSuggestions.style;
  $('target-minutes').value = reviewSuggestions.targetMinutes;
  $('scene-count').value = reviewSuggestions.sceneCount;
  $('privacy').value = reviewSuggestions.privacy;
  $('narration').checked = reviewSuggestions.narration !== false;
  $('captions').checked = reviewSuggestions.captions !== false;
  $('auto-publish').checked = reviewSuggestions.autoPublish === true;
  updateScriptCounter();
  $('form-message').className = 'form-message success';
  $('form-message').textContent = 'As sugestões foram aplicadas. Revise os campos antes de iniciar a produção.';
});
$('review-script-button').addEventListener('click', async () => {
  const button = $('review-script-button');
  const script = $('script-input').value.trim();
  const message = $('form-message');
  if (!script) {
    message.className = 'form-message error';
    message.textContent = 'Escreva ou cole um roteiro antes de solicitar a revisão.';
    $('script-input').focus();
    return;
  }
  button.disabled = true;
  button.querySelector('span').textContent = 'Revisando';
  message.className = 'form-message';
  message.textContent = 'A IA está analisando o roteiro.';
  try {
    const response = await request('/api/review-script', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script, style: $('style').value, targetMinutes: Number($('target-minutes').value), sceneCount: Number($('scene-count').value), privacy: $('privacy').value, narration: $('narration').checked, captions: $('captions').checked, autoPublish: $('auto-publish').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível revisar o roteiro.');
    $('script-review-content').textContent = result.report;
    reviewSuggestions = result.suggestions || null;
    if (reviewSuggestions) {
      const styleNames = { story: 'História narrada', educational: 'Estudo bíblico', explainer: 'Explicação', list: 'Lista temática' };
      const privacyNames = { private: 'Privado', unlisted: 'Não listado', public: 'Público' };
      $('review-suggestions').innerHTML = `<span><small>Formato</small><strong>${text(styleNames[reviewSuggestions.style] || reviewSuggestions.style)}</strong></span><span><small>Duração</small><strong>${text(reviewSuggestions.targetMinutes)} min</strong></span><span><small>Cenas</small><strong>${text(reviewSuggestions.sceneCount)}</strong></span><span><small>Visibilidade</small><strong>${text(privacyNames[reviewSuggestions.privacy] || reviewSuggestions.privacy)}</strong></span><span><small>Narração</small><strong>${reviewSuggestions.narration === false ? 'Não' : 'Sim'}</strong></span><span><small>Legendas</small><strong>${reviewSuggestions.captions === false ? 'Não' : 'Sim'}</strong></span>`;
    }
    $('script-review').hidden = false;
    message.className = 'form-message success';
    message.textContent = result.limited
      ? 'Revisão básica concluída. A análise aprofundada poderá ser refeita quando a IA estiver disponível.'
      : result.sampled ? `Revisão concluída por amostragem de ${Number(result.reviewedCharacters).toLocaleString('pt-BR')} caracteres.` : 'Revisão concluída.';
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Revisar com IA';
  }
});

$('generate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('generate-button');
  const message = $('form-message');
  button.disabled = true;
  button.querySelector('span').textContent = 'Produzindo';
  message.className = 'form-message';
  message.textContent = 'A produção começou. Esta etapa pode levar alguns minutos.';
  try {
    const response = await request('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: $('script-input').value.trim() || null, style: $('style').value, targetMinutes: Number($('target-minutes').value), sceneCount: Number($('scene-count').value), privacy: $('privacy').value, narration: $('narration').checked, captions: $('captions').checked, autoPublish: $('auto-publish').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível iniciar a produção.');
    message.className = 'form-message success';
    message.textContent = 'Produção registrada. Abrindo as confirmações do servidor.';
    $('script-input').value = '';
    updateScriptCounter();
    await loadDashboard();
    openContent(result.contentId);
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message || 'Não foi possível iniciar a produção.';
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Iniciar produção';
  }
});

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_target_minutes: $('default-minutes').value, default_scene_count: $('default-scenes').value }) });
  $('settings-message').textContent = response.ok ? 'Configurações salvas.' : 'Não foi possível salvar.';
});

async function loadSettings() {
  const [response, authResponse] = await Promise.all([request('/settings'), request('/api/auth/status')]);
  if (authResponse.ok) $('account-username').value = (await authResponse.json()).username || '';
  if (!response.ok) return;
  const settings = await response.json();
  $('default-minutes').value = settings.default_target_minutes || 8;
  $('default-scenes').value = settings.default_scene_count || 8;
  $('target-minutes').value = settings.default_target_minutes || 8;
  $('scene-count').value = settings.default_scene_count || 8;
}

$('confirm-password').addEventListener('blur', () => {
  const matches = $('confirm-password').value === $('new-password').value;
  $('confirm-password').setCustomValidity(matches ? '' : 'As senhas não coincidem.');
});

$('account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('account-message');
  if ($('new-password').value !== $('confirm-password').value) {
    $('confirm-password').setCustomValidity('As senhas não coincidem.');
    $('confirm-password').reportValidity();
    return;
  }
  message.className = 'form-message';
  message.textContent = 'Atualizando acesso.';
  const response = await request('/api/account', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('account-username').value.trim(), currentPassword: $('current-password').value, newPassword: $('new-password').value }) });
  const result = await response.json();
  if (!response.ok) {
    message.className = 'form-message error';
    message.textContent = result.error || 'Não foi possível atualizar o acesso.';
    message.focus();
    if (result.field === 'username') $('account-username').focus();
    if (result.field === 'newPassword') $('new-password').focus();
    return;
  }
  message.className = 'form-message success';
  message.textContent = 'Acesso atualizado. Redirecionando para o login.';
  setTimeout(() => window.location.assign('/login'), 900);
});

showView(initialContentId ? 'detail' : window.location.hash.slice(1) || 'overview', false);
loadDashboard();
loadSettings();
connectProductionEvents();
setInterval(loadDashboard, 30000);
setInterval(loadJobs, 10000);
setInterval(() => { if (selectedContentId && document.querySelector('.app-view[data-view="detail"].active')) loadProductionDetail(selectedContentId); }, 10000);

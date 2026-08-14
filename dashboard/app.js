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
const statusLabels = { processing: 'Em produção', ready: 'Pronto', scheduled: 'Agendado', published: 'Publicado', simulated: 'Precisa de atenção', failed: 'Falhou' };
let contentItems = [];

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
  if (updateHash) window.history.replaceState(null, '', `#${view}`);
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
    return `<article class="library-card" data-content-id="${text(item.id)}" tabindex="0" role="button" aria-label="Abrir ${text(item.title)}"><span class="content-thumb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 8 7 4-7 4z"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg></span><div class="content-main"><strong title="${text(item.title)}">${text(item.title)}</strong><div class="library-meta"><span>${text(item.topic)}</span><span>${text(item.duration || 'Duração não informada')}</span><span>${text(formatDate(item.createdAt))}</span></div></div><div class="library-actions"><span class="status-badge status-${text(item.status)}">${text(statusText)}</span>${youtubeLink}</div></article>`;
  }).join('') : emptyState(Boolean(query || status !== 'all'));
  const emptyCreate = document.querySelector('[data-empty-create]');
  if (emptyCreate) emptyCreate.addEventListener('click', () => showView('create'));
  document.querySelectorAll('[data-content-id]').forEach((card) => {
    const open = (event) => { if (event.target.closest('a')) return; openContent(card.dataset.contentId); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
  });
}

function openContent(id) {
  const item = contentItems.find((content) => content.id === id);
  if (!item) return;
  $('detail-title').textContent = item.title;
  $('detail-status').textContent = statusLabels[item.status] || item.status;
  $('detail-meta').textContent = `${item.topic} · ${item.duration || 'Duração não informada'} · ${formatDate(item.createdAt)}`;
  $('video-frame').innerHTML = item.videoUrl ? `<video controls playsinline preload="metadata" src="${text(item.videoUrl)}"${item.thumbnailUrl ? ` poster="${text(item.thumbnailUrl)}"` : ''}></video>` : '<div class="video-empty"><strong>Vídeo ainda indisponível</strong><p>Quando a montagem terminar, o player aparecerá aqui.</p></div>';
  showView('detail');
}

function updateConnections(data) {
  const channel = data.youtube || {};
  const youtubeStatus = channel.connected ? `${Number(channel.subscribers || 0).toLocaleString('pt-BR')} inscritos · ${Number(channel.videos || 0).toLocaleString('pt-BR')} vídeos` : channel.authorized ? 'Conta Google autorizada, mas nenhum canal foi encontrado nessa conta' : 'Conecte uma conta oficial do Google';
  $('connections-grid').innerHTML = `<article class="metric-card connection-card"><span>Canal do YouTube</span><strong>${text(channel.title || (channel.authorized ? 'Google autorizado' : 'Não conectado'))}</strong><small>${youtubeStatus}</small><a class="primary-button connection-action" href="/auth/google"><span>${channel.authorized ? 'Escolher outra conta' : 'Conectar com Google'}</span></a></article><article class="metric-card"><span>Inteligência artificial</span><strong>${text(data.ai?.provider || 'Não conectada')}</strong><small>${data.ai?.connected ? 'Disponível para produção' : 'Configuração necessária'}</small></article><article class="metric-card"><span>Mídia dos vídeos</span><strong>${text(data.storage?.provider || 'Railway')}</strong><small>${text(data.storage?.bucket || 'Armazenamento local')}</small></article><article class="metric-card"><span>Banco de dados</span><strong>${text(data.database?.provider || 'Não conectado')}</strong><small>${data.database?.connected ? `Gerenciado pela ${text(data.database.managedBy)}` : 'Configuração necessária'}</small></article><article class="metric-card"><span>Arquivos internos</span><strong>Volume Railway</strong><small>Credenciais e arquivos temporários</small></article>`;
  $('reports-grid').innerHTML = `<article class="metric-card"><span>Inscritos</span><strong>${Number(channel.subscribers || 0).toLocaleString('pt-BR')}</strong><small>Canal conectado</small></article><article class="metric-card"><span>Visualizações</span><strong>${Number(channel.views || 0).toLocaleString('pt-BR')}</strong><small>Total do canal</small></article><article class="metric-card"><span>Vídeos</span><strong>${Number(channel.videos || 0).toLocaleString('pt-BR')}</strong><small>Publicados no canal</small></article>`;
}

function updateJobs(jobs) {
  const active = (jobs || []).find((job) => !['completed', 'failed'].includes(job.stage));
  $('production-panel').hidden = !active;
  if (!active) return;
  $('production-stage').textContent = active.message;
  $('production-message').textContent = `Etapa atual: ${active.stage}`;
  $('production-percent').textContent = `${active.progress}%`;
  $('production-progress').style.width = `${active.progress}%`;
}

async function loadJobs() {
  try {
    const response = await request('/production-status');
    if (response.ok) updateJobs(await response.json());
  } catch (_error) {
    // The full dashboard refresh handles connection state.
  }
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

$('generate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('generate-button');
  const message = $('form-message');
  button.disabled = true;
  button.querySelector('span').textContent = 'Produzindo';
  message.className = 'form-message';
  message.textContent = 'A produção começou. Esta etapa pode levar alguns minutos.';
  try {
    const response = await request('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: $('topic').value.trim() || null, style: $('style').value, targetMinutes: Number($('target-minutes').value), sceneCount: Number($('scene-count').value), privacy: $('privacy').value, narration: $('narration').checked, captions: $('captions').checked, autoPublish: $('auto-publish').checked }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível iniciar a produção.');
    message.className = 'form-message success';
    message.textContent = 'Produção iniciada. Você pode acompanhar o progresso na visão geral.';
    $('topic').value = '';
    await loadDashboard();
    showView('overview');
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
  const response = await request('/settings');
  if (!response.ok) return;
  const settings = await response.json();
  $('default-minutes').value = settings.default_target_minutes || 8;
  $('default-scenes').value = settings.default_scene_count || 8;
  $('target-minutes').value = settings.default_target_minutes || 8;
  $('scene-count').value = settings.default_scene_count || 8;
}

showView(window.location.hash.slice(1) || 'overview', false);
loadDashboard();
loadSettings();
setInterval(loadDashboard, 30000);
setInterval(loadJobs, 2000);

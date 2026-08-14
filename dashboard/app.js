/* global fetch */

const $ = (id) => document.getElementById(id);

const agentLabels = {
  strategy: 'Estratégia', scriptWriter: 'Roteiro', thumbnailDesigner: 'Miniatura',
  seoOptimizer: 'SEO', production: 'Produção', publishing: 'Publicação', analytics: 'Análise'
};

function text(value) {
  return String(value ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function formatUptime(seconds = 0) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} h ${minutes} min em operação`;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Sessão expirada');
  }
  return response;
}

function updateHealth(data) {
  const healthy = data.status === 'healthy' && data.initialized;
  $('system-status').textContent = healthy ? 'Operação normal' : 'Inicializando';
  $('header-status').textContent = healthy ? 'Sistema ativo' : 'Verificando';
  $('agent-count').textContent = `${data.agents?.length || 0} de 7`;
  $('last-updated').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  $('uptime').textContent = formatUptime(data.uptime);
  $('agent-status').innerHTML = (data.agents || []).map((agent) => `
    <div class="agent"><i aria-hidden="true"></i><span>${text(agentLabels[agent] || agent)}</span></div>
  `).join('');
}

function updateSchedule(items) {
  const schedule = Array.isArray(items) ? items : [];
  if (!schedule.length) {
    $('upcoming-schedule').innerHTML = `
      <div class="list-item"><div><strong>Geração diária</strong><br><small>Preparação automática de conteúdo</small></div><strong>06:00</strong></div>
      <div class="list-item"><div><strong>Análise do canal</strong><br><small>Leitura de desempenho</small></div><strong>09:00</strong></div>`;
    $('next-generation').textContent = '06:00';
    return;
  }
  $('upcoming-schedule').innerHTML = schedule.slice(0, 4).map((item) => {
    const date = new Date(item.publishTime || item.scheduledTime);
    return `<div class="list-item"><div><strong>${text(item.title || 'Nova publicação')}</strong><br><small>${text(date.toLocaleDateString('pt-BR'))}</small></div><strong>${text(date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))}</strong></div>`;
  }).join('');
  const next = new Date(schedule[0].publishTime || schedule[0].scheduledTime);
  $('next-generation').textContent = next.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function updateMetrics(data = {}) {
  const total = data.totalVideos || 0;
  $('content-count').textContent = total;
  $('published-count').textContent = data.publishedVideos ?? total;
  $('performance-metrics').innerHTML = `
    <div><dt>Conteúdo registrado</dt><dd>${text(total)}</dd></div>
    <div><dt>Pontuação média</dt><dd>${text(data.averagePerformanceScore || 'Aguardando dados')}</dd></div>
    <div><dt>Automação</dt><dd>Ativa</dd></div>`;
}

async function loadDashboard() {
  try {
    const [healthResponse, scheduleResponse, analyticsResponse] = await Promise.all([
      request('/health'), request('/schedule'), request('/analytics')
    ]);
    updateHealth(await healthResponse.json());
    updateSchedule(await scheduleResponse.json());
    updateMetrics(await analyticsResponse.json());
  } catch (error) {
    if (error.message !== 'Sessão expirada') {
      $('system-status').textContent = 'Conexão indisponível';
      $('header-status').textContent = 'Sem conexão';
    }
  }
}

$('generate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('generate-button');
  const message = $('form-message');
  button.disabled = true;
  button.querySelector('span').textContent = 'Iniciando produção';
  message.className = 'form-message';
  message.textContent = 'O roteiro, a narração e os visuais estão sendo preparados.';
  try {
    const response = await request('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: $('topic').value.trim() || null, style: $('style').value, length: $('length').value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível iniciar a produção.');
    message.className = 'form-message success';
    message.textContent = `Produção iniciada: ${result.result?.title || 'novo vídeo bíblico'}.`;
    $('topic').value = '';
    await loadDashboard();
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message || 'Não foi possível iniciar a produção.';
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Iniciar produção';
  }
});

$('refresh-button').addEventListener('click', loadDashboard);
$('logout-button').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.assign('/login');
});

loadDashboard();
setInterval(loadDashboard, 30000);

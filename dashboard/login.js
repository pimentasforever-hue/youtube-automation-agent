/* global fetch */

const form = document.getElementById('login-form');
const message = document.getElementById('login-message');
const button = document.getElementById('login-button');
const password = document.getElementById('password');
const toggle = document.getElementById('password-toggle');

toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.textContent = show ? 'Ocultar' : 'Mostrar';
  toggle.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.querySelector('span').textContent = 'Verificando';
  message.className = 'form-message';
  message.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.');
    window.location.assign('/');
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message;
    password.focus();
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Entrar';
  }
});

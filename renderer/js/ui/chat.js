// Discord conversation view: recent messages of a DM or channel, updating
// live. Discord's local RPC can't send messages, so "Reply in Discord" opens
// the conversation in Discord itself.

import { h, escapeHtml, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { api, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { mountOverlay, FocusList } from './overlay.js';
import { renderHints } from './glyphs.js';
import { t } from '../i18n.js';

function avatar(m) {
  if (m.avatar) return `<img src="${escapeHtml(m.avatar)}" alt="" loading="lazy">`;
  return `<span>${escapeHtml((m.author || '?').charAt(0).toUpperCase())}</span>`;
}

export async function openChat(conv) {
  const list = h('div', { class: 'chat-list' }, h('div', { class: 'chat-loading' }, h('div', { class: 'spinner' })));
  const reply = h('button', { class: 'dlg-btn fx', html: `${icon('external')}<span>${escapeHtml(t('Reply in Discord'))}</span>` });
  const close = h('button', { class: 'dlg-btn fx', text: t('Close') });
  const hints = h('div', { class: 'chat-hints' });
  renderHints(hints, [
    ['adjust', 'Scroll'],
    ['confirm', 'Select'],
    ['back', 'Close'],
  ]);
  const root = h(
    'div',
    { class: 'overlay dialog-overlay chat-overlay' },
    h(
      'div',
      { class: 'dialog chat-dialog' },
      h('div', { class: 'chat-head' }, conv.icon ? h('img', { class: 'chat-icon', src: conv.icon, alt: '' }) : h('div', { class: 'chat-icon', html: icon('party') }), h('div', { class: 'dlg-title', text: conv.name })),
      list,
      h('div', { class: 'dlg-btns' }, reply, close),
      hints
    )
  );
  const nav = new FocusList([reply, close]);
  let chat = null;
  const lastIds = new Set();

  const row = (m, prev) => {
    const grouped = prev && prev.authorId === m.authorId && m.time - prev.time < 5 * 60000;
    return h('div', {
      class: `chat-msg${m.self ? ' self' : ''}${grouped ? ' grouped' : ''}`,
      html: grouped
        ? `<div class="chat-av"></div><div class="chat-body"><div class="chat-text">${escapeHtml(m.content)}</div></div>`
        : `<div class="chat-av">${avatar(m)}</div><div class="chat-body"><div class="chat-meta"><b>${escapeHtml(m.author)}</b><span>${escapeHtml(timeAgo(m.time))}</span></div><div class="chat-text">${escapeHtml(m.content)}</div></div>`,
    });
  };

  function renderAll(messages) {
    list.innerHTML = '';
    if (!messages.length) list.append(h('div', { class: 'chat-empty', text: t('No messages to show.') }));
    messages.forEach((m, i) => {
      lastIds.add(m.id);
      list.append(row(m, messages[i - 1]));
    });
    list.scrollTop = list.scrollHeight;
  }

  const off = api.on('discord:chat', (e) => {
    if (!chat || !e || e.channelId !== chat.channelId || lastIds.has(e.message.id)) return;
    const prev = chat.messages[chat.messages.length - 1];
    chat.messages.push(e.message);
    lastIds.add(e.message.id);
    list.querySelector('.chat-empty')?.remove();
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
    list.append(row(e.message, prev));
    if (atBottom) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    if (!e.message.self) sfx.message();
  });

  const finish = () => {
    off();
    api.discordCloseChat().catch(() => {});
    ctl.close();
  };
  const openInDiscord = () => {
    sfx.select();
    api.discordOpenInDiscord(conv.channelId, chat && chat.guildId).catch(() => {});
    finish();
  };
  reply.addEventListener('click', openInDiscord);
  close.addEventListener('click', () => (sfx.back(), finish()));

  const ctl = mountOverlay(root, (action) => {
    if (action === 'back') {
      sfx.back();
      finish();
    } else if (action === 'up' || action === 'down') {
      list.scrollBy({ top: (action === 'up' ? -1 : 1) * list.clientHeight * 0.4, behavior: 'smooth' });
    } else if (action === 'left' || action === 'right') {
      if (nav.move(action === 'left' ? -1 : 1)) sfx.move();
    } else if (action === 'confirm') {
      if (nav.index === 0) openInDiscord();
      else {
        sfx.back();
        finish();
      }
    }
    return true;
  });
  sfx.open();

  try {
    chat = await api.discordOpenChat(conv.channelId);
    renderAll(chat.messages);
  } catch (err) {
    list.innerHTML = '';
    list.append(h('div', { class: 'chat-empty', text: t("Discord didn't share this conversation. You can still open it in Discord.") }));
    pushNotification({ title: 'Discord', body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'party', kind: 'party', silent: true });
  }
  return ctl;
}

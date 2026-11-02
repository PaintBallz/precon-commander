// Feature ideas and bug reports sent from the footer's "Suggest a feature"
// button. Players see their own and any reply; the site admin gets an inbox on
// the Account page and marks each one planned, done or declined.
import { db } from './db.js';

export const KINDS = ['idea', 'bug', 'other'];
export const STATUSES = ['new', 'planned', 'done', 'declined'];
const TEXT_MIN = 5;
const TEXT_MAX = 2000;
const REPLY_MAX = 500;
const PER_HOUR = 5;

class FeedbackError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const row = r => r && {
  id: r.id, userId: r.user_id, username: r.username, kind: r.kind, text: r.text,
  status: r.status, reply: r.reply, createdAt: r.created_at, updatedAt: r.updated_at,
};
const get = id => row(db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(id)));
export const newFeedbackCount = () => db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").get().n;

// onChange(item) runs after every change so the server can tell open pages.
export function feedbackRoutes(app, wrap, onChange = () => {}) {
  app.post('/api/feedback', wrap(async (req, res) => {
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'idea';
    const text = String(req.body?.text || '').trim();
    if (text.length < TEXT_MIN) throw new FeedbackError(400, 'Tell me a little more (at least a few words).');
    if (text.length > TEXT_MAX) throw new FeedbackError(400, `Keep it under ${TEXT_MAX} characters.`);
    const since = new Date(Date.now() - 3600e3).toISOString();
    const recent = db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?').get(req.user.id, since).n;
    if (recent >= PER_HOUR) throw new FeedbackError(429, 'That\'s a lot of ideas! Try again in a bit.');
    const { lastInsertRowid } = db.prepare('INSERT INTO feedback (user_id, username, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, req.user.username, kind, text, new Date().toISOString());
    const item = get(lastInsertRowid);
    onChange(item);
    res.json({ ok: true, item });
  }));

  // The admin sees everything (?status= narrows it); players see their own.
  app.get('/api/feedback', wrap(async (req, res) => {
    if (!req.user.isAdmin) {
      return res.json({ items: db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC').all(req.user.id).map(row) });
    }
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const items = db.prepare(`SELECT * FROM feedback ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC`).all(...(status ? [status] : [])).map(row);
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all()) counts[r.status] = r.n;
    res.json({ items, counts });
  }));

  app.put('/api/feedback/:id', wrap(async (req, res) => {
    if (!req.user.isAdmin) throw new FeedbackError(403, 'Only the admin can do that.');
    const item = get(req.params.id);
    if (!item) throw new FeedbackError(404, 'Not found.');
    const status = req.body?.status ?? item.status;
    if (!STATUSES.includes(status)) throw new FeedbackError(400, 'Unknown status.');
    const reply = String(req.body?.reply ?? item.reply).trim();
    if (reply.length > REPLY_MAX) throw new FeedbackError(400, `Keep the reply under ${REPLY_MAX} characters.`);
    db.prepare('UPDATE feedback SET status = ?, reply = ?, updated_at = ? WHERE id = ?').run(status, reply, new Date().toISOString(), item.id);
    const updated = get(item.id);
    onChange(updated);
    res.json({ ok: true, item: updated });
  }));

  // The admin can delete anything; a player can take back their own until it's been looked at.
  app.delete('/api/feedback/:id', wrap(async (req, res) => {
    const item = get(req.params.id);
    if (!item) throw new FeedbackError(404, 'Not found.');
    if (!req.user.isAdmin && !(item.userId === req.user.id && item.status === 'new')) throw new FeedbackError(403, 'You can only delete your own suggestions that haven\'t been reviewed yet.');
    db.prepare('DELETE FROM feedback WHERE id = ?').run(item.id);
    onChange({ ...item, deleted: true });
    res.json({ ok: true });
  }));
}

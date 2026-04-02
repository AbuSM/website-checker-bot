require("dotenv").config();
const { Telegraf } = require("telegraf");
const { Database } = require("bun:sqlite");
const axios = require("axios");
const cron = require("node-cron");

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Database("./websites.db");

// Инициализация таблиц
db.run(`
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY,
		username TEXT,
		first_name TEXT
	)
`);

db.run(`
	CREATE TABLE IF NOT EXISTS websites (
		id INTEGER PRIMARY KEY,
		url TEXT,
		last_status TEXT,
		user_id INTEGER,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)
`);

// Миграция: добавить user_id если его нет (старая схема)
const columns = db.prepare("PRAGMA table_info(websites)").all();
if (!columns.some((c) => c.name === "user_id")) {
	db.run("ALTER TABLE websites ADD COLUMN user_id INTEGER REFERENCES users(id)");
}

// 🧑 Записываем или обновляем пользователя
const upsertUserStmt = db.prepare(
	`INSERT INTO users (id, username, first_name)
	 VALUES (?, ?, ?)
	 ON CONFLICT(id) DO UPDATE SET
		username = excluded.username,
		first_name = excluded.first_name`
);

function upsertUser(ctx) {
	const user = ctx.from;
	upsertUserStmt.run(user.id, user.username || "", user.first_name || "");
}

// Команда /start
bot.start((ctx) => {
	upsertUser(ctx);
	ctx.reply(
		"Привет! Отправь мне ссылку, и я буду следить за её доступностью."
	);
});

// Команда /list — показать сайты пользователя
bot.command("list", (ctx) => {
	upsertUser(ctx);
	const rows = db.prepare("SELECT url, last_status FROM websites WHERE user_id = ?").all(ctx.from.id);
	if (rows.length === 0) return ctx.reply("Сайты не найдены.");
	const msg = rows
		.map(
			(r) =>
				`${r.url} — ${
					r.last_status === "online"
						? "🟢 доступен"
						: "🔴 не работает"
				}`
		)
		.join("\n");
	ctx.reply(msg);
});

// /delete <url>
bot.command("delete", (ctx) => {
	upsertUser(ctx);
	const parts = ctx.message.text.split(" ").slice(1);
	if (parts.length !== 1) return ctx.reply("Используй: /delete <url>");

	const url = parts[0].trim();
	const result = db.prepare("DELETE FROM websites WHERE url = ? AND user_id = ?").run(url, ctx.from.id);
	if (result.changes === 0) return ctx.reply("Сайт не найден.");
	ctx.reply(`🗑️ Сайт ${url} удалён.`);
});

// /update <old_url> <new_url>
bot.command("update", (ctx) => {
	upsertUser(ctx);
	const parts = ctx.message.text.split(" ").slice(1);
	if (parts.length !== 2)
		return ctx.reply("Используй: /update <старый_url> <новый_url>");

	const [oldUrl, newUrl] = parts;
	if (!/^https?:\/\//.test(newUrl)) {
		return ctx.reply("Новый URL должен начинаться с http:// или https://");
	}

	const result = db.prepare("UPDATE websites SET url = ?, last_status = 'unknown' WHERE url = ? AND user_id = ?").run(newUrl, oldUrl, ctx.from.id);
	if (result.changes === 0) return ctx.reply("Старый URL не найден.");
	ctx.reply(`✏️ Сайт обновлён: ${oldUrl} → ${newUrl}`);
});

// Добавление сайта по тексту
bot.on("text", (ctx) => {
	upsertUser(ctx);
	const url = ctx.message.text.trim();
	if (!/^https?:\/\//.test(url))
		return ctx.reply(
			"Пожалуйста, отправь корректный URL, начиная с http:// или https://"
		);

	try {
		db.prepare("INSERT INTO websites (url, last_status, user_id) VALUES (?, ?, ?)").run(url, "unknown", ctx.from.id);
		ctx.reply("Добавил сайт в список! Я буду проверять его каждые 5 минут.");
	} catch {
		ctx.reply("Ошибка при добавлении URL или он уже существует.");
	}
});

// Автоматическая проверка сайтов
const updateStatusStmt = db.prepare("UPDATE websites SET last_status = ? WHERE id = ?");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

async function checkSite(url) {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await axios.get(url, {
				timeout: 10000,
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; WebsiteCheckerBot/1.0)",
				},
				maxRedirects: 5,
				// Считаем любой HTTP-ответ как "сайт работает"
				validateStatus: () => true,
			});
			return true; // Сайт ответил — значит работает
		} catch (err) {
			// Сетевая ошибка или таймаут — пробуем ещё
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
			}
		}
	}
	return false; // Все попытки провалились
}

cron.schedule("*/5 * * * *", async () => {
	const rows = db.prepare("SELECT * FROM websites").all();

	for (const row of rows) {
		const isOnline = await checkSite(row.url);

		if (isOnline && row.last_status !== "online") {
			updateStatusStmt.run("online", row.id);
			if (row.last_status === "offline") {
				bot.telegram.sendMessage(
					row.user_id,
					`✅ Сайт ${row.url} снова доступен!`
				);
			}
		} else if (!isOnline && row.last_status !== "offline") {
			updateStatusStmt.run("offline", row.id);
			bot.telegram.sendMessage(
				row.user_id,
				`⚠️ Сайт ${row.url} недоступен!`
			);
		}
	}
});

// Запуск
bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

import fastify from "fastify";
import * as crypto from "node:crypto";
import fastifyRawBody from "fastify-raw-body";

const {
	PORT = 5000,
	PYRUS_SECRET = "",
	GITLAB_TOKEN = "",
	GITLAB_API_BASE = "https://gitlab.example.com/api/v4",
	GITLAB_PROJECT_ID = "1",
	GITLAB_SCHEDULE_ID = "6",
	GITLAB_REF = "master",
	WAIT_MIN = "30",
} = process.env;

const TIMEOUT_MS = 15_000;
const WAIT = Number(WAIT_MIN);
const app = fastify({ logger: true });

await app.register(fastifyRawBody, {
	field: "rawBody",
	global: false,
	encoding: "utf8",
	runFirst: true,
});

async function fetchWithTimeout(url: string, opts: RequestInit & { timeout?: number } = {}) {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), opts.timeout ?? TIMEOUT_MS);
	return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function gl(path: string, method: "GET" | "POST" = "GET") {
	const url = `${GITLAB_API_BASE}${path}`;
	app.log.info({ method, url }, "GitLab call");
	return await fetchWithTimeout(url, {
		method,
		headers: {
			"PRIVATE-TOKEN": GITLAB_TOKEN,
			"Content-Type": "application/json",
		},
	});
}

async function hasActivePipeline(): Promise<boolean> {
	const url =
		`/projects/${GITLAB_PROJECT_ID}/pipelines` +
		`?ref=${encodeURIComponent(GITLAB_REF)}&per_page=1&order_by=id&sort=desc`;

	const res = await gl(url);
	if (!res.ok) {
		app.log.error({ status: res.status }, "GitLab /pipelines failed");
		return true;
	}

	const [last] = (await res.json()) as any[];
	if (!last) return false;

	app.log.info({ id: last.id, status: last.status }, "last pipeline");
	return ["running", "pending"].includes(last.status);
}

async function playSchedule(): Promise<boolean> {
	const res = await gl(
		`/projects/${GITLAB_PROJECT_ID}/pipeline_schedules/${GITLAB_SCHEDULE_ID}/play`,
		"POST",
	);
	app.log.info({ status: res.status }, "play schedule result");
	return res.ok;
}

function checkSig(raw: Buffer | string, sigHeader: string | undefined) {
	if (!sigHeader) return false;
	const signature = sigHeader.toLowerCase().trim();
	const digest = crypto
		.createHmac("sha1", PYRUS_SECRET)
		.update(raw)
		.digest("hex")
		.toLowerCase();
	const ok = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
	app.log.info({ ok }, "HMAC check");
	return ok;
}

async function pyrusComment(task: number, token: string, text: string) {
	app.log.info({ task }, "sending comment to Pyrus");
	const r = await fetchWithTimeout(`https://api.pyrus.com/v4/tasks/${task}/comments`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text }),
	});
	app.log.info({ status: r.status }, "comment sent");
}

app.post("/", { config: { rawBody: true } }, async (req, rep) => {
	const raw = req.rawBody as Buffer | string | undefined;
	if (!raw) {
		app.log.error("empty rawBody");
		return rep.code(400).send();
	}

	if (!checkSig(raw, req.headers["x-pyrus-sig"] as string | undefined)) {
		app.log.warn("invalid signature — 403");
		return rep.code(403).send();
	}

	const { task, access_token: token } = req.body as any;
	const taskId = task.id;
	app.log.info({ taskId }, "processing task");

	if (await hasActivePipeline()) {
		await pyrusComment(
			taskId,
			token,
			`Пайплайн уже в работе / в очереди. Попробуйте проверить результат через ${WAIT} мин.`,
		);
		return rep.code(200).send();
	}

	if (await playSchedule()) {
		await pyrusComment(
			taskId,
			token,
			`Запустил пайплайн. Проверьте результат через ${WAIT} мин.`,
		);
	} else {
		await pyrusComment(
			taskId,
			token,
			"Не смог запустить: GitLab вернул ошибку =( Позовите разработчика.",
		);
	}

	rep.code(200).send();
});

app.listen({ host: "0.0.0.0", port: Number(PORT) }, (err, addr) => {
	if (err) {
		app.log.error(err, "startup failed");
		process.exit(1);
	}
	app.log.info({ addr }, "server listening");
});

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
    WAIT_MIN = "30",
} = process.env;

const WAIT = Number(WAIT_MIN);

const app = fastify({ logger: true });
await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
});

function checkSig(raw: Buffer, sig: string | undefined) {
    if (!sig) return false;

    const h = crypto.createHmac("sha1", PYRUS_SECRET).update(raw).digest("hex");

    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sig.toLowerCase()));
}

function gl(path: string, method: string = "GET") {
    return fetch(`${GITLAB_API_BASE}${path}`, {
        method,
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN, "Content-Type": "application/json" },
    });
}

async function scheduleRunning(): Promise<boolean> {
    const res = await gl(
        `/projects/${GITLAB_PROJECT_ID}/pipeline_schedules/${GITLAB_SCHEDULE_ID}/pipelines?per_page=1`
    );

    if (!res.ok) return true;

    const [last] = (await res.json()) as any[];

    return last && ["running", "pending"].includes(last.status);
}

async function playSchedule(): Promise<boolean> {
    const res = await gl(
        `/projects/${GITLAB_PROJECT_ID}/pipeline_schedules/${GITLAB_SCHEDULE_ID}/play`,
        "POST"
    );

    return res.ok;
}

async function pyrusComment(task: number, token: string, text: string) {
    await fetch(`https://api.pyrus.com/v4/tasks/${task}/comments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
}

app.post("/", { config: { rawBody: true } }, async (req, rep) => {
    const raw = req.rawBody as Buffer | undefined;
    if (!raw) return rep.code(400).send();

    const payload = req.body as any;
    const taskId = payload.task.id;
    const token = payload.access_token;

    if (await scheduleRunning()) {
        await pyrusComment(
            taskId,
            token,
            `Уже крутится/в очереди. Подождите ${WAIT} мин.`
        );
        return rep.code(200).send();
    }

    if (await playSchedule()) {
        await pyrusComment(
            taskId,
            token,
            `Запустил расписание #${GITLAB_SCHEDULE_ID}. Вернусь через ${WAIT} мин.`
        );
    } else {
        await pyrusComment(
            taskId,
            token,
            "Не смог запустить: GitLab вернул ошибку. Проверьте руками."
        );
    }

    rep.code(200).send();
});

app.listen({ host: "0.0.0.0", port: Number(PORT) });

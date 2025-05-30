# Pyrus Gitlab schedules bot

## Разворачивание бота
git clone …
cd pyrus-gitlab-bot
heroku create your-bot
heroku config:set \
  PYRUS_SECRET=секрет_из_настроек_бота \
  GITLAB_TOKEN=xxxx \
  GITLAB_API_BASE=https://gitlab.pyrus.local/api/v4 \
  GITLAB_PROJECT_ID=project_id \
  GITLAB_SCHEDULE_ID=schedule_id

git push heroku main

## Использование
В Pyrus: Создать бота, URL = https://your-bot.herokuapp.com/
Секрет вставить в PYRUS_SECRET.

Тегнуть @bot в комментарии. Он проверит расписание #schedule_id, запустит если надо, и ответит тем же комментом.

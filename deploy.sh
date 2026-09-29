#!/usr/bin/env bash
# blueee 网站一键部署
# 用法（在 Git Bash 中，于本仓库根目录执行）：
#   ./deploy.sh              # 测试 → 构建 → 备份数据库 → 上传线上 → 填写提交说明 → 推送两个仓库
#   ./deploy.sh "修了滤波笔记"  # 同上，提交说明直接用参数里的这句
#
# 前提：v2ray 开着（git 推送走 127.0.0.1:10808）；
#       ~/.ssh/config 里有 blueee-server 别名。服务器文件不需要代理。

set -euo pipefail

# ===== 配置区（按需修改）=====
PROXY="http://127.0.0.1:10808"     # 本地代理，仅用于 git push GitHub
SSH_HOST="blueee-server"           # ~/.ssh/config 里的服务器别名
OPS_DIR="/d/my_project/server-ops" # 私有运维仓（blueee-server-pri）的本地路径
# =============================

cd "$(dirname "$0")"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# 提交说明：优先用第一个参数；没传就在动手前问一次（避免构建完才卡在等输入）
MSG="${1:-}"
if [ -z "$MSG" ]; then
  read -r -p "请输入本次提交说明: " MSG
  MSG="${MSG:-网站更新 $(date '+%F %H:%M')}"
fi

step "1/6 运行测试"
(cd project && npm test)

step "2/6 构建站点"
(cd project && npm run build)

step "3/6 备份服务器评论数据库"
ssh "$SSH_HOST" 'set -e
  cfg=/www/wwwroot/website-comments-config.php
  dbu=$(grep -oP "\x27user\x27\s*=>\s*\x27\K[^\x27]+" "$cfg")
  dbp=$(grep -oP "\x27password\x27\s*=>\s*\x27\K[^\x27]+" "$cfg")
  mkdir -p /www/backup/database
  f=/www/backup/database/website_comments-$(date +%Y%m%d-%H%M%S).sql.gz
  MYSQL_PWD="$dbp" mysqldump --no-tablespaces -u"$dbu" website_comments | gzip > "$f"
  ls -t /www/backup/database/website_comments-*.sql.gz | tail -n +11 | xargs -r rm --
  echo "数据库已备份: $f"' || echo "⚠ 数据库备份失败，继续部署（静态站不受影响）"

step "4/6 上传新版本到服务器"
tar -C project/dist -czf - . | ssh "$SSH_HOST" 'set -e
  tmp=$(mktemp -d /www/wwwroot/.deploy-XXXX)
  tar -C "$tmp" -xzf -
  find /www/wwwroot/website -mindepth 1 -maxdepth 1 ! -name ".user.ini" -exec rm -rf {} +
  shopt -s dotglob nullglob
  mv "$tmp"/* /www/wwwroot/website/
  rmdir "$tmp"
  chown -R www:www /www/wwwroot/website
  echo "线上文件已更新"'

step "5/6 推送公开仓 blueee-website（源码）"
export http_proxy="$PROXY" https_proxy="$PROXY" GIT_TERMINAL_PROMPT=0
git add -A
if git diff --cached --quiet; then
  echo "公开仓无改动"
else
  git commit -q -m "$MSG"
fi
git push -q origin main

step "6/6 推送私有仓 blueee-server-pri（运维）"
if [ -d "$OPS_DIR/.git" ]; then
  (
    cd "$OPS_DIR"
    git add -A
    if git diff --cached --quiet; then
      echo "私有仓无改动"
    else
      git commit -q -m "运维更新 $(date '+%F %H:%M')"
    fi
    git push -q origin main
  )
else
  echo "⚠ 未找到私有仓 $OPS_DIR，跳过（不影响部署）"
fi
unset http_proxy https_proxy GIT_TERMINAL_PROMPT

step "全部完成 ✔  线上网站、公开仓、私有仓三处已同步"

-- 2026-09-28 评论功能升级迁移：回复（楼中楼）+ 访客自动昵称。
-- 在 phpMyAdmin 的 SQL 页签对 website_comments 执行一次即可；
-- 新建数据库直接导入 schema.sql，无需执行本文件。

USE website_comments;

ALTER TABLE comments
    ADD COLUMN parent_id BIGINT UNSIGNED NULL AFTER note_slug,
    ADD COLUMN root_id BIGINT UNSIGNED NULL AFTER parent_id,
    ADD COLUMN author_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER root_id,
    ADD COLUMN author_name VARCHAR(48) NULL AFTER author_key,
    ADD INDEX idx_comments_root (root_id, status, id);

CREATE TABLE IF NOT EXISTS comment_identities (
    author_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    display_name VARCHAR(48) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uq_identities_name (display_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

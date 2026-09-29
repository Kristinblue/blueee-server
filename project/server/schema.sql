CREATE DATABASE IF NOT EXISTS website_comments CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE website_comments;

CREATE TABLE IF NOT EXISTS comments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    note_slug VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    root_id BIGINT UNSIGNED NULL,
    author_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    author_name VARCHAR(48) NULL,
    content TEXT NOT NULL,
    status ENUM('visible', 'hidden') NOT NULL DEFAULT 'visible',
    created_at DATETIME(6) NOT NULL,
    INDEX idx_comments_note (note_slug, status, id),
    INDEX idx_comments_root (root_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comment_identities (
    author_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    display_name VARCHAR(48) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uq_identities_name (display_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comment_rate_subjects (
    subject_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    last_seen DATETIME(6) NOT NULL,
    INDEX idx_rate_subject_last_seen (last_seen)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comment_rate_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    comment_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL,
    INDEX idx_rate_subject_time (subject_key, created_at),
    INDEX idx_rate_event_time (created_at)
) ENGINE=InnoDB;

-- 页宠聊天的限流表：结构和评论的限流表一致，但额度独立
CREATE TABLE IF NOT EXISTS chat_rate_subjects (
    subject_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    last_seen DATETIME(6) NOT NULL,
    INDEX idx_chat_rate_subject_last_seen (last_seen)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_rate_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    INDEX idx_chat_rate_subject_time (subject_key, created_at),
    INDEX idx_chat_rate_event_time (created_at)
) ENGINE=InnoDB;

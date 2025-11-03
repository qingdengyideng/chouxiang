// 常量定义
const CACHE_EXPIRE_DAYS = 5;
const EMOJI_DB_NAME = 'emojiDB';
const EMOJI_STORE_NAME = 'emojis';
let db = null;

// 初始化IndexedDB
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(EMOJI_DB_NAME, 2); // 版本升级到2

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // 删除旧的对象存储（如果存在）
            if (db.objectStoreNames.contains(EMOJI_STORE_NAME)) {
                db.deleteObjectStore(EMOJI_STORE_NAME);
            }
            // 创建新的对象存储，使用自增主键
            const store = db.createObjectStore(EMOJI_STORE_NAME, {
                keyPath: 'id',
                autoIncrement: true
            });
            store.createIndex('key', 'key', { unique: true });
            store.createIndex('timestamp', 'timestamp', { unique: false });
        };
    });
}

// ⚡ 通用异步加载图片函数
async function replaceImagePlaceholders(container, getImageUrlFn, placeholderSelector = '.emoji-placeholder', source = 'default') {
    const placeholders = Array.from(container.querySelectorAll(placeholderSelector));
    if (placeholders.length === 0) return;

    // 并发获取所有图片URL
    const promises = placeholders.map(async (placeholder) => {
        const key = placeholder.getAttribute('data-emoji-key');
        try {
            const imageUrl = await getImageUrlFn(key);
            if (!imageUrl) throw new Error('图片不存在');

            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = key;
            img.title = key;
            img.style.cursor = "pointer";
            let width = '100%';

            // 可以自定义大小规则
            if (source === 'default') {
                width = /\d/.test(key) ? '60%' : '10%';
            } else if (source === 'player') {
                width = /\d/.test(key) ? '30%' : '20%';
            }

            img.style.width = width;
            img.style.height = width;

            // 点击预览
            if (source === 'default' || source === 'player') {
                img.addEventListener('click', () => showImagePreview(img.src));
            }

            placeholder.replaceWith(img);
        } catch (err) {
            console.warn(`加载图片失败: ${key}`, err);
            placeholder.textContent = `[${key}]`;
            placeholder.classList.remove('emoji-placeholder');
        }
    });

    // 等待所有图片加载完成（并发）
    await Promise.all(promises);
}

function showImagePreview(src) {
    // 创建遮罩层
    let preview = document.createElement("div");
    preview.className = "image-preview-overlay";
    preview.innerHTML = `
        <div class="image-preview-content">
            <img src="${src}" alt="preview">
        </div>
    `;
    document.body.appendChild(preview);

    const img = preview.querySelector('img');

    // 移动端全屏，PC端占80%
    if (/Mobi|Android/i.test(navigator.userAgent)) {
        // 移动端
        img.style.width = "100vw";
        img.style.height = "100vh";
        img.style.objectFit = "contain";
    } else {
        // PC端
        img.style.maxWidth = "80vw";
        img.style.maxHeight = "80vh";
        img.style.objectFit = "contain";
    }

    // 点击遮罩关闭
    preview.addEventListener("click", () => {
        document.body.removeChild(preview);
    });
}

// 根据 emojiKey 获取图片 URL
async function getEmojiImageUrl(emojiKey) {
    try {
        // Step 1: 先查缓存
        const cachedUrl = await getCachedImage(emojiKey);
        if (cachedUrl) {
            return cachedUrl;
        }

        // Step 2: 请求后端接口
        const apiUrl = `https://guanxi.icu/webhook/queryByEmojiName?emojiName=${encodeURIComponent(emojiKey)}`;
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`获取emoji接口失败: ${response.status}`);
            return null;
        }

        const data = await response.json();
        if (!data || !data.url) {
            console.error('emoji接口返回异常:', data);
            return null;
        }

        // 构造 emoji 对象供 cacheEmojiImage 使用
        const emoji = {
            emojiname: data.emoji_name,
            id: data.id,
            url: data.url
        };

        // Step 3: 缓存图片并返回 blobUrl
        const blobUrl = await cacheEmojiImage(emoji);
        return blobUrl;
    } catch (error) {
        console.error('getEmojiImageUrl 出错:', error);
        return null;
    }
}

// 从IndexedDB获取缓存的图片
async function getCachedImage(key) {
    if (!db) await initDB();

    return new Promise((resolve) => {
        const transaction = db.transaction([EMOJI_STORE_NAME], 'readonly');
        const store = transaction.objectStore(EMOJI_STORE_NAME);
        const index = store.index('key');
        const request = index.get(key);

        request.onsuccess = () => {
            const result = request.result;
            if (result && !isCacheExpired(result.timestamp)) {
                const blob = new Blob([result.blob], { type: result.type });
                resolve(URL.createObjectURL(blob));
            } else {
                resolve(null);
            }
        };
        request.onerror = () => resolve(null);
    });
}

// 缓存图片到IndexedDB
async function cacheEmojiImage(emoji) {
    try {
        const key = getCacheKey(emoji);

        // 检查是否有缓存
        const cachedUrl = await getCachedImage(key);
        if (cachedUrl) return cachedUrl;

        // 获取网络图片
        const response = await fetch(emoji.url);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

        const blob = await response.blob();
        const blobBuffer = await blob.arrayBuffer();

        // 存储到IndexedDB
        return new Promise((resolve) => {
            if (!db) {
                resolve(emoji.url);
                return;
            }

            const transaction = db.transaction([EMOJI_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(EMOJI_STORE_NAME);

            const item = {
                key: key,
                blob: blobBuffer,
                type: blob.type,
                timestamp: Date.now(),
                url: emoji.url // 保存原始URL用于调试
            };

            const request = store.add(item);
            request.onsuccess = () => {
                const blobUrl = URL.createObjectURL(blob);
                resolve(blobUrl);
            };
            request.onerror = (event) => {
                console.error('缓存失败:', event.target.error);
                resolve(emoji.url);
            };
        });
    } catch (error) {
        console.error('缓存图片失败:', error);
        return null;
    }
}

// 获取缓存键名
function getCacheKey(emoji) {
    return emoji.emojiname || `no.${emoji.id}`;
}

// 检查缓存是否过期
function isCacheExpired(timestamp) {
    if (CACHE_EXPIRE_DAYS === 0) return true;
    return Date.now() - timestamp > CACHE_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
}

// 清理过期缓存
async function clearExpiredCache() {

    if (!db) await initDB();
    if (CACHE_EXPIRE_DAYS === 0) return;

    return new Promise((resolve) => {
        const transaction = db.transaction([EMOJI_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(EMOJI_STORE_NAME);
        const index = store.index('timestamp');
        const request = index.openCursor();

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                if (isCacheExpired(cursor.value.timestamp)) {
                    cursor.delete();
                }
                cursor.continue();
            } else {
                resolve();
            }
        };

        request.onerror = () => resolve();
    });
}

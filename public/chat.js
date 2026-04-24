marked.setOptions({ breaks: true });

function renderMarkdown(text) {
    try {
        const result = marked.parse(text);
        const html = typeof result === 'string' ? result : '';
        return DOMPurify.sanitize(html || text.replace(/\n/g, '<br>'));
    } catch (e) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    }
}

let ragMode = false;

const history = { normal: [], rag: [] };

function currentHistory() {
    return ragMode ? history.rag : history.normal;
}

function addMessage(text, role) {
    const msg = $('<div>').addClass('message ' + role);
    if (role === 'ai') {
        msg.html(renderMarkdown(text));
    } else {
        msg.text(text);
    }
    $('#chat-box').append(msg);
    currentHistory().push({ text, role });
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function renderHistory(messages) {
    $('#chat-box').empty();
    messages.forEach(function(m) {
        const msg = $('<div>').addClass('message ' + m.role);
        if (m.role === 'ai') {
            msg.html(renderMarkdown(m.text));
        } else {
            msg.text(m.text);
        }
        $('#chat-box').append(msg);
    });
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function showTyping() {
    const bubble = $('<div class="message ai typing-bubble">');
    bubble.html('<div class="typing-indicator"><span></span><span></span><span></span></div>');
    $('#chat-box').append(bubble);
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function hideTyping() {
    $('.typing-bubble').remove();
}

function setInputLock(locked) {
    $('#chat-input').prop('disabled', locked);
    $('#send-btn').prop('disabled', locked);
    if (!locked) $('#chat-input').focus();
}

async function sendMessage() {
    const text = $('#chat-input').val().trim();
    if (text === '') return;

    addMessage(text, 'user');
    $('#chat-input').val('');
    setInputLock(true);
    showTyping();

    try {
        const response = await fetch(ragMode ? '/api/rag/chat' : '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text }),
        });
        const data = await response.json();
        hideTyping();

        if (data.error) {
            addMessage('오류: ' + data.error, 'ai');
        } else {
            addMessage(data.reply, 'ai');
            if (ragMode && data.sources && data.sources.length > 0) {
                const sourceNames = data.sources.map(s => s.split('/').pop()).join(', ');
                addMessage('출처: ' + sourceNames, 'source');
            }
        }
    } catch (err) {
        hideTyping();
        addMessage('오류가 발생했습니다.', 'ai');
    } finally {
        setInputLock(false);
    }
}

// RAG 상태 (문서 수 + 청크 수)
function loadRagStatus() {
    $.ajax({
        url: '/api/rag/status',
        method: 'GET',
        success: function(data) {
            $('#stat-docs').text((data.total_documents ?? '-') + '개');
            $('#stat-chunks').text((data.total_chunks ?? '-') + '개');
        },
        error: function() {
            $('#stat-docs').text('-');
            $('#stat-chunks').text('-');
        }
    });
}

// 모달에 문서 목록 렌더링
function renderDocuments(docs) {
    const list = $('#doc-modal-list');
    list.empty();
    if (!docs || docs.length === 0) {
        list.append('<div class="doc-empty">업로드된 문서가 없습니다.</div>');
        return;
    }
    docs.forEach(function(name) {
        const item = $('<div class="doc-item">');
        const nameSpan = $('<span class="doc-item-name">').text(name);
        const deleteBtn = $('<button class="doc-delete-btn">').text('✕');
        deleteBtn.on('click', function() {
            deleteDocument(name);
        });
        item.append(nameSpan).append(deleteBtn);
        list.append(item);
    });
}

function loadDocuments() {
    $.ajax({
        url: '/api/rag/documents',
        method: 'GET',
        success: function(data) {
            renderDocuments(data.documents);
        }
    });
}

function deleteDocument(filename) {
    $.ajax({
        url: '/api/rag/documents/' + encodeURIComponent(filename),
        method: 'DELETE',
        success: function() {
            loadDocuments();
            loadRagStatus();
        },
        error: function() {
            alert('삭제에 실패했습니다.');
        }
    });
}

// 모달 열기/닫기
function openDocModal() {
    loadDocuments();
    $('#doc-modal-overlay').addClass('visible');
}

function closeDocModal() {
    $('#doc-modal-overlay').removeClass('visible');
}

$('#doc-list-btn').on('click', openDocModal);
$('#doc-modal-close').on('click', closeDocModal);
$('#doc-modal-overlay').on('click', function(e) {
    if (e.target === this) closeDocModal();
});

// 모드 토글
$('#btn-normal').on('click', function() {
    if (!ragMode) return;
    ragMode = false;
    $('#btn-normal').addClass('active');
    $('#btn-rag').removeClass('active');
    $('#rag-panel').removeClass('visible');
    $('#header-title').text('AI 채팅');
    renderHistory(history.normal);
});

$('#btn-rag').on('click', function() {
    if (ragMode) return;
    ragMode = true;
    $('#btn-rag').addClass('active');
    $('#btn-normal').removeClass('active');
    $('#rag-panel').addClass('visible');
    $('#header-title').text('AI 채팅 (RAG)');
    renderHistory(history.rag);
    loadRagStatus();
});

// 파일 업로드
$('#file-input').on('change', function() {
    const file = this.files[0];
    if (!file) return;

    $('#upload-msg').text('업로드 중... ' + file.name).removeClass('error').addClass('uploading');
    $('#file-input').prop('disabled', true);
    $('#upload-label').addClass('disabled');

    const formData = new FormData();
    formData.append('file', file);

    $.ajax({
        url: '/api/rag/upload',
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(data) {
            let msg = '✓ ' + data.filename + ' 완료 (텍스트 ' + data.chunks + '개 청크';
            if (data.image_descriptions > 0) {
                msg += ', 이미지 ' + data.image_descriptions + '개 설명';
            }
            msg += ')';
            $('#upload-msg').text(msg).removeClass('uploading error');
            loadRagStatus();
        },
        error: function() {
            $('#upload-msg').text('✗ 업로드 실패').removeClass('uploading').addClass('error');
        },
        complete: function() {
            $('#file-input').prop('disabled', false);
            $('#upload-label').removeClass('disabled');
        }
    });

    $(this).val('');
});

$('#send-btn').on('click', sendMessage);
$('#chat-input').on('keydown', function(e) {
    if (e.key === 'Enter') sendMessage();
});

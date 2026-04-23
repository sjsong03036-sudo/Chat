let ragMode = false;

// 모드별 대화 내역 저장소
const history = { normal: [], rag: [] };

function currentHistory() {
    return ragMode ? history.rag : history.normal;
}

function addMessage(text, role) {
    const msg = $('<div>');
    msg.addClass('message ' + role);
    msg.text(text);
    $('#chat-box').append(msg);

    currentHistory().push({ text, role });

    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function renderHistory(messages) {
    $('#chat-box').empty();
    messages.forEach(function(m) {
        const msg = $('<div>');
        msg.addClass('message ' + m.role);
        msg.text(m.text);
        $('#chat-box').append(msg);
    });
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function sendMessage() {
    const text = $('#chat-input').val().trim();
    if (text === '') return;

    addMessage(text, 'user');
    $('#chat-input').val('');

    const endpoint = ragMode ? '/api/rag/chat' : '/api/chat';

    $.ajax({
        url: endpoint,
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ message: text }),
        success: function(data) {
            addMessage(data.reply, 'ai');
            if (ragMode && data.sources && data.sources.length > 0) {
                const sourceNames = data.sources.map(s => s.split('/').pop()).join(', ');
                addMessage('출처: ' + sourceNames, 'source');
            }
        },
        error: function() {
            addMessage('오류가 발생했습니다.', 'ai');
        }
    });
}

function loadRagStatus() {
    $.ajax({
        url: '/api/rag/status',
        method: 'GET',
        success: function(data) {
            $('#rag-status').text('문서 ' + data.total_chunks + '개 청크 로드됨');
        },
        error: function() {
            $('#rag-status').text('RAG 서버 연결 안 됨');
        }
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

function renderDocuments(docs) {
    const list = $('#doc-list');
    list.empty();
    if (!docs || docs.length === 0) {
        list.append('<div class="doc-empty">업로드된 문서 없음</div>');
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
    loadDocuments();
});

// 파일 업로드
$('#file-input').on('change', function() {
    const file = this.files[0];
    if (!file) return;

    // 업로드 중 UI
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
            loadDocuments();
        },
        error: function() {
            $('#upload-msg').text('✗ 업로드 실패').removeClass('uploading').addClass('error');
        },
        complete: function() {
            // 성공/실패 무관하게 입력 복원
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

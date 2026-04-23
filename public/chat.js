let ragMode = false;

function addMessage(text, role) {
    const msg = $('<div>');
    msg.addClass('message ' + role);
    msg.text(text);
    $('#chat-box').append(msg);

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

// 모드 토글
$('#btn-normal').on('click', function() {
    ragMode = false;
    $('#btn-normal').addClass('active');
    $('#btn-rag').removeClass('active');
    $('#rag-panel').removeClass('visible');
    $('#header-title').text('AI 채팅');
});

$('#btn-rag').on('click', function() {
    ragMode = true;
    $('#btn-rag').addClass('active');
    $('#btn-normal').removeClass('active');
    $('#rag-panel').addClass('visible');
    $('#header-title').text('AI 채팅 (RAG)');
    loadRagStatus();
});

// 파일 업로드
$('#file-input').on('change', function() {
    const file = this.files[0];
    if (!file) return;

    $('#upload-msg').text('업로드 중...');

    const formData = new FormData();
    formData.append('file', file);

    $.ajax({
        url: '/api/rag/upload',
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(data) {
            let msg = data.filename + ' 업로드 완료 (텍스트 ' + data.chunks + '개 청크';
            if (data.image_descriptions > 0) {
                msg += ', 이미지 ' + data.image_descriptions + '개 설명';
            }
            msg += ')';
            $('#upload-msg').text(msg);
            loadRagStatus();
        },
        error: function() {
            $('#upload-msg').text('업로드 실패');
        }
    });

    $(this).val('');
});

$('#send-btn').on('click', sendMessage);

$('#chat-input').on('keydown', function(e) {
    if (e.key === 'Enter') sendMessage();
});

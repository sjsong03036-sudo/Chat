// $() → jQuery 선택자. CSS 선택자 문법 그대로 사용
// $('#id'), $('.class'), $('태그')

function addMessage(text, role) {
    const msg = $('<div>');              // 새 <div> 요소 생성
    msg.addClass('message ' + role);    // 클래스 추가
    msg.text(text);                     // 텍스트 삽입 (.innerText 대신)
    $('#chat-box').append(msg);         // chat-box 안에 추가 (.appendChild 대신)

    // 스크롤 맨 아래로
    // [0] → jQuery 객체를 일반 DOM 요소로 꺼냄 (scrollHeight는 순수 JS 속성)
    const box = $('#chat-box')[0];
    box.scrollTop = box.scrollHeight;
}

function getAIResponse(userText) {
    return '(AI 응답 준비 중) "' + userText + '"';
}

function sendMessage() {
    const text = $('#chat-input').val().trim();  // .value 대신 .val()
    if (text === '') return;

    addMessage(text, 'user');
    $('#chat-input').val('');                    // 입력창 비우기

    const aiText = getAIResponse(text);
    addMessage(aiText, 'ai');
}

// .on('이벤트', 함수) → addEventListener 대신
$('#send-btn').on('click', sendMessage);

$('#chat-input').on('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
});

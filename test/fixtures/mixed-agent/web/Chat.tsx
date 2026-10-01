export function Chat({ messages }: { messages: string[] }) {
  return (
    <ul>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

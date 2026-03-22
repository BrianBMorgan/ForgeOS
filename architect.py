import os
import subprocess
from google import genai
from google.genai import types

# 1. Config
API_KEY = "AIzaSyAuye5-4pp6yCa0lQA2hJXArZwf0NPOD4Y"
REPO_PATH = os.getcwd()
MODEL_ID = "gemini-2.5-pro"

client = genai.Client(api_key=API_KEY)

# 2. Permanent Tools (The Handshake)
def read_file(path: str) -> str:
    """Reads a file from the repository."""
    try:
        with open(os.path.join(REPO_PATH, path), 'r') as f:
            return f.read()
    except Exception as e:
        return str(e)

def push_file(path: str, content: str, message: str) -> str:
    """Writes a file and pushes it to GitHub."""
    full_path = os.path.join(REPO_PATH, path)
    with open(full_path, 'w') as f:
        f.write(content)
    subprocess.run(["git", "add", path], cwd=REPO_PATH)
    subprocess.run(["git", "commit", "-m", message], cwd=REPO_PATH)
    subprocess.run(["git", "push", "origin", "main"], cwd=REPO_PATH)
    return f"Success: {message}"

# 3. The Orchestrator
print(f"--- FORGE OS ARCHITECT SHELL ({MODEL_ID}) ---")
print("Ready for instructions. (Type 'exit' to quit)")

chat = client.chats.create(
    model=MODEL_ID,
    config=types.GenerateContentConfig(
        tools=[read_file, push_file],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=False),
        system_instruction="You are the ForgeOS Architect. Use read_file and push_file to maintain the repo."
    )
)

while True:
    user_prompt = input("\nArchitect Command > ")
    if user_prompt.lower() in ["exit", "quit"]:
        break
    
    # Execute the command
    response = chat.send_message(user_prompt)
    print(f"\nResult: {response.text}")
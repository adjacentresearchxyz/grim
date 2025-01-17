export interface Player {
  id: number;
  name: string;
  role: string;
}

export interface UserAction {
  type: 'info' | 'feed' | 'action';
  player: Player;
  content: string;
}

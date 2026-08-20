import { useEffect, useState } from "react";

export const useTypewriter = (text: string, speed: number = 100) => {
	const [displayText, setDisplayText] = useState("");
	const [isComplete, setIsComplete] = useState(false);

	useEffect(() => {
		setDisplayText("");
		setIsComplete(false);

		if (text.length === 0) {
			setIsComplete(true);
			return;
		}

		let i = 0;
		const timer = setInterval(() => {
			setDisplayText(text.slice(0, i + 1));
			i++;
			if (i === text.length) {
				setIsComplete(true);
				clearInterval(timer);
			}
		}, speed);

		return () => clearInterval(timer);
	}, [text, speed]);

	return { displayText, isComplete };
};
